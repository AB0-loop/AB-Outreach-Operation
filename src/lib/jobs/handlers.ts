import { db } from "@/db";
import {
  emailMessages,
  prospects,
  replies,
  reports,
  settings as settingsTable,
  processedEvents,
  appointments,
  approvals,
} from "@/db/schema";
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { getSettings, updateSettings, evaluateSendGate } from "../settings";
import { checkEligibility } from "../eligibility";
import { evaluateDailyBudget, remainingDailyQuota, sentTodayCount } from "../budget";
import { composeMessage } from "../compose";
import { transition, STOP_STATES, type ProspectState } from "../state";
import { findSuppression, suppress, SuppressionUnavailableError, normalizeEmail } from "../suppression";
import {
  classifyReply,
  extractPhone,
  detectAppointment,
  STOP_CLASSIFICATIONS,
  ALERT_CLASSIFICATIONS,
} from "../classify";
import {
  sendEmail,
  findSentTo,
  listInbound,
  startWatch,
  GmailNotAuthorizedError,
} from "../providers/gmail";
import { generateReportSet } from "../report";
import { enqueueNotification, esc } from "../providers/telegram";
import { notifyCritical, notifyReply } from "../notify";
import { addBusinessDays, isWithinSendWindow, pacingJitterMs, startOfZonedDay } from "../time";
import { stableKey } from "../crypto";
import { audit } from "../audit";
import { errorMessage, log } from "../log";
import { DependencyJobError, enqueueJob, PermanentJobError } from "./queue";
import { env } from "../env";

/* ------------------------------------------------------------------ */
/* 1. Verify discovered prospects                                      */
/* ------------------------------------------------------------------ */
export async function verifyProspects(): Promise<string> {
  const rows = await db
    .select()
    .from(prospects)
    .where(eq(prospects.status, "DISCOVERED"))
    .limit(50);

  let verified = 0;
  let review = 0;
  for (const p of rows) {
    const problems: string[] = [];
    if (p.emailStatus !== "source_verified")
      problems.push(`email status is ${p.emailStatus}`);
    if (!p.emailSourceUrl) problems.push("no email source URL");
    if (!p.qualificationReason) problems.push("no qualification reason");
    if (!p.bengaluruEvidenceUrl && !p.sourceUrl)
      problems.push("no Bengaluru evidence");

    try {
      if (await findSuppression(p.email)) {
        await transition({
          prospectId: p.id,
          to: "UNSUBSCRIBED",
          reason: "Already on global suppression list at verification",
          extra: { nextAction: "None — suppressed" },
        });
        continue;
      }
    } catch {
      continue; // suppression unavailable: leave for the next pass
    }

    if (problems.length > 0) {
      await transition({
        prospectId: p.id,
        to: "REVIEW",
        reason: `Verification incomplete: ${problems.join("; ")}`,
        extra: {
          reviewReason: problems.join("; "),
          nextAction: "Operator review required",
        },
      });
      review += 1;
    } else {
      await transition({
        prospectId: p.id,
        to: "VERIFIED",
        reason: "Identity, source and email verification satisfied",
        extra: { lastVerifiedAt: new Date(), nextAction: "Eligibility check" },
      });
      verified += 1;
    }
  }
  return `verified=${verified} review=${review}`;
}

/* ------------------------------------------------------------------ */
/* 2. Promote verified prospects to ELIGIBLE                           */
/* ------------------------------------------------------------------ */
export async function promoteEligible(): Promise<string> {
  const s = await getSettings();
  const rows = await db
    .select()
    .from(prospects)
    .where(eq(prospects.status, "VERIFIED"))
    .limit(50);

  let eligible = 0;
  let blocked = 0;
  for (const p of rows) {
    const result = await checkEligibility(p, s);
    // Configuration-level blockers are not the prospect's fault: leave the
    // prospect VERIFIED so it is retried once the operator fixes config.
    const gateReasons = new Set(evaluateSendGate(s).reasons);
    const prospectBlockers = result.blockers.filter((b) => !gateReasons.has(b));

    if (result.eligible) {
      await transition({
        prospectId: p.id,
        to: "ELIGIBLE",
        reason: "All eligibility checks passed",
        extra: { nextAction: "Draft and queue initial email" },
      });
      eligible += 1;
    } else if (prospectBlockers.length > 0) {
      await transition({
        prospectId: p.id,
        to: "REVIEW",
        reason: `Ineligible: ${prospectBlockers.join("; ")}`,
        extra: {
          reviewReason: prospectBlockers.join("; "),
          nextAction: "Operator review required",
        },
      });
      blocked += 1;
    }
  }
  return `eligible=${eligible} review=${blocked}`;
}

/* ------------------------------------------------------------------ */
/* 3. Draft + validate + quality-review + queue                        */
/* ------------------------------------------------------------------ */
export async function draftAndQueue(): Promise<string> {
  const s = await getSettings();
  const gate = evaluateSendGate(s);
  if (!gate.allowed) return `skipped: ${gate.reasons.join("; ")}`;

  const alreadyQueued = await db
    .select({ n: sql<string>`count(*)` })
    .from(emailMessages)
    .where(eq(emailMessages.status, "queued"));
  const quota = await remainingDailyQuota(s);
  const capacity = Math.max(0, quota - Number(alreadyQueued[0]?.n ?? 0));
  if (capacity === 0) return "skipped: adaptive daily budget already committed";

  // Segments are selected independently; the 80/20 split is a research
  // target, never a reason to queue a weak prospect.
  const take = async (segment: string, limit: number) =>
    limit <= 0
      ? []
      : db
          .select()
          .from(prospects)
          .where(and(eq(prospects.status, "ELIGIBLE"), eq(prospects.segment, segment)))
          .orderBy(desc(prospects.leadScore), asc(prospects.id))
          .limit(limit);

  const wantPlanners = Math.round((capacity * (100 - s.professionalRatio)) / 100);
  const planners = await take("event_planner", wantPlanners);
  const professionals = await take("professional", capacity - planners.length);
  const picked = [...professionals, ...planners].slice(0, capacity);

  let queued = 0;
  let blocked = 0;
  for (const p of picked) {
    const recheck = await checkEligibility(p, s);
    if (!recheck.eligible) {
      await transition({
        prospectId: p.id,
        to: "REVIEW",
        reason: `Re-check failed at draft time: ${recheck.blockers.join("; ")}`,
        extra: { reviewReason: recheck.blockers.join("; ") },
      });
      blocked += 1;
      continue;
    }

    const draft = await composeMessage({ prospect: p, settings: s, isFollowup: false });
    const idempotencyKey = stableKey("msg", p.id, "initial");

    const common = {
      prospectId: p.id,
      kind: "initial" as const,
      subject: draft.subject,
      bodyText: draft.body,
      validationReport: draft.validation,
      qualityScore: draft.quality.score,
      qualityReport: draft.quality,
      claimIds: draft.claimIds,
      generator: draft.generator,
      aiProvider: draft.provider,
      personalizationHook: draft.hook,
      regenerations: draft.attempts,
      idempotencyKey,
    };

    // A draft is only sendable when BOTH factual validation and the quality
    // threshold pass. Nothing is ever sent merely to use up the budget.
    if (!draft.sendable) {
      await db
        .insert(emailMessages)
        .values({ ...common, status: "blocked", blockedReason: draft.blockedReason })
        .onConflictDoNothing({ target: emailMessages.idempotencyKey });
      await transition({
        prospectId: p.id,
        to: "REVIEW",
        reason: `Draft rejected: ${draft.blockedReason}`,
        extra: {
          reviewReason: `quality ${draft.quality.score}/${s.minQualityScore} · ${draft.validation.issues.map((i) => i.code).join(",") || "validation ok"}`,
          nextAction: "Improve evidence or template, then re-queue",
        },
      });
      blocked += 1;
      continue;
    }

    await db
      .insert(emailMessages)
      .values({
        ...common,
        status: "queued",
        scheduledFor: new Date(Date.now() + pacingJitterMs(`${p.id}-initial`)),
      })
      .onConflictDoNothing({ target: emailMessages.idempotencyKey });

    await transition({
      prospectId: p.id,
      to: "QUEUED",
      reason: `Validated draft (quality ${draft.quality.score}, ${draft.provider}) queued`,
      extra: { nextAction: "Send within business hours" },
    });
    queued += 1;
  }
  return `queued=${queued} blocked=${blocked} capacity=${capacity}`;
}

/* ------------------------------------------------------------------ */
/* 4. Send due messages                                                */
/* ------------------------------------------------------------------ */
export async function sendDueMessages(now: Date = new Date()): Promise<string> {
  const s = await getSettings();
  const gate = evaluateSendGate(s);
  if (!gate.allowed) return `blocked: ${gate.reasons.join("; ")}`;
  if (!isWithinSendWindow(now, s.timezone, s.sendWindowStartHour, s.sendWindowEndHour))
    return "outside send window";

  const due = await db
    .select()
    .from(emailMessages)
    .where(
      and(
        eq(emailMessages.status, "queued"),
        or(isNull(emailMessages.scheduledFor), lte(emailMessages.scheduledFor, now)),
      ),
    )
    .orderBy(asc(emailMessages.scheduledFor))
    .limit(10);

  let sent = 0;
  let skipped = 0;
  for (const m of due) {
    // Follow-ups and new messages share one adaptive budget.
    if ((await remainingDailyQuota(s)) <= 0) {
      skipped += 1;
      continue;
    }
    const [p] = await db.select().from(prospects).where(eq(prospects.id, m.prospectId));
    if (!p) continue;

    // Final fail-closed suppression + state check immediately before send.
    try {
      const sup = await findSuppression(p.email);
      if (sup) {
        await db
          .update(emailMessages)
          .set({ status: "blocked", blockedReason: `suppressed:${sup.reason}`, updatedAt: new Date() })
          .where(eq(emailMessages.id, m.id));
        skipped += 1;
        continue;
      }
    } catch (e) {
      if (e instanceof SuppressionUnavailableError) {
        await notifyCritical({
          title: "Suppression lookup failed — sending halted",
          detail: errorMessage(e),
          dedupeKey: `supp-fail-${new Date().toISOString().slice(0, 13)}`,
        });
        throw new DependencyJobError("Suppression unavailable; refusing to send");
      }
      throw e;
    }

    if (STOP_STATES.includes(p.status as ProspectState)) {
      await db
        .update(emailMessages)
        .set({ status: "blocked", blockedReason: `stop_state:${p.status}`, updatedAt: new Date() })
        .where(eq(emailMessages.id, m.id));
      skipped += 1;
      continue;
    }

    // Reconcile any uncertain prior attempt before retrying.
    if (m.status === "uncertain") {
      const existing = await findSentTo(p.email, m.subject);
      if (existing) {
        await markSent(m.id, p.id, existing.gmailMessageId, existing.gmailThreadId, m.kind);
        continue;
      }
    }

    try {
      const prior = m.kind === "followup"
        ? (
            await db
              .select()
              .from(emailMessages)
              .where(and(eq(emailMessages.prospectId, p.id), eq(emailMessages.kind, "initial")))
              .limit(1)
          )[0]
        : undefined;

      const res = await sendEmail({
        from: s.senderEmail,
        fromName: s.senderName,
        to: p.email,
        subject: m.subject,
        body: m.bodyText,
        threadId: prior?.gmailThreadId ?? null,
        inReplyTo: prior?.rfcMessageId ?? null,
      });
      await markSent(m.id, p.id, res.gmailMessageId, res.gmailThreadId, m.kind);
      sent += 1;
    } catch (e) {
      if (e instanceof GmailNotAuthorizedError) {
        await notifyCritical({
          title: "Gmail authorization failure — sending paused",
          detail: errorMessage(e),
          dedupeKey: `gmail-auth-${new Date().toISOString().slice(0, 13)}`,
        });
        throw new DependencyJobError(errorMessage(e));
      }
      // Outcome uncertain: never blind-retry. Reconciled on the next pass.
      await db
        .update(emailMessages)
        .set({ status: "uncertain", error: errorMessage(e), updatedAt: new Date() })
        .where(eq(emailMessages.id, m.id));
      await notifyCritical({
        title: "Send outcome uncertain — awaiting Gmail reconciliation",
        detail: `Message ${m.id} to prospect ${p.id}: ${errorMessage(e)}`,
        dedupeKey: `send-uncertain-${m.id}`,
      });
      skipped += 1;
    }
  }
  return `sent=${sent} skipped=${skipped}`;
}

async function markSent(
  messageId: number,
  prospectId: number,
  gmailMessageId: string,
  gmailThreadId: string,
  kind: string,
) {
  await db
    .update(emailMessages)
    .set({
      status: "sent",
      gmailMessageId,
      gmailThreadId,
      sentAt: new Date(),
      error: null,
      updatedAt: new Date(),
    })
    .where(eq(emailMessages.id, messageId));
  await transition({
    prospectId,
    to: "SENT",
    reason: `${kind} email sent (gmail ${gmailMessageId})`,
    extra: {
      nextAction: kind === "initial" ? "Await reply; follow-up after 4 business days" : "Await reply; no further follow-up",
    },
  });
  await audit({
    actor: "system",
    action: "email.sent",
    entity: "email_messages",
    entityId: messageId,
    detail: { gmailThreadId, kind },
  });
}

/* ------------------------------------------------------------------ */
/* 5. Poll + process replies (idempotent)                              */
/* ------------------------------------------------------------------ */
export async function pollReplies(): Promise<string> {
  const s = await getSettings();
  let inbound;
  try {
    inbound = await listInbound(25);
  } catch (e) {
    if (e instanceof GmailNotAuthorizedError) throw new DependencyJobError(errorMessage(e));
    throw e;
  }

  let processed = 0;
  let duplicates = 0;
  for (const msg of inbound) {
    const marker = await db
      .insert(processedEvents)
      .values({ source: "gmail_message", eventId: msg.id })
      .onConflictDoNothing()
      .returning({ id: processedEvents.id });
    if (!marker[0]) {
      duplicates += 1;
      continue;
    }

    try {
      await processInbound({
        gmailMessageId: msg.id,
        gmailThreadId: msg.threadId,
        from: msg.from,
        subject: msg.subject,
        body: msg.body,
        receivedAt: msg.receivedAt,
        settingsTimezone: s.timezone,
      });
      processed += 1;
    } catch (e) {
      // Roll back the idempotency marker so the message is retried.
      await db.delete(processedEvents).where(eq(processedEvents.id, marker[0].id));
      log.error("reply_processing_failed", { id: msg.id, error: errorMessage(e) });
      throw e;
    }
  }
  return `replies=${processed} duplicates=${duplicates}`;
}

function parseEmailAddress(raw: string): string {
  const m = /<([^>]+)>/.exec(raw);
  return normalizeEmail(m ? m[1] : raw);
}

/** Finds the bounced recipient inside a delivery-status notification body. */
function bouncedRecipient(body: string): string | null {
  const m =
    /final-recipient:\s*rfc822;\s*([^\s<>]+@[^\s<>]+)/i.exec(body) ??
    /(?:to|recipient)[:\s]+<?([^\s<>]+@[^\s<>]+)>?/i.exec(body);
  return m ? normalizeEmail(m[1]) : null;
}

export async function processInbound(input: {
  gmailMessageId: string;
  gmailThreadId: string;
  from: string;
  subject: string;
  body: string;
  receivedAt: Date;
  settingsTimezone: string;
}): Promise<void> {
  const s = await getSettings();
  const fromEmail = parseEmailAddress(input.from);

  const cls = await classifyReply({
    fromEmail,
    subject: input.subject,
    body: input.body,
  });

  // Resolve the prospect: by thread first, then by address, then (for bounces)
  // by the final-recipient header inside the DSN.
  let prospect =
    (
      await db
        .select()
        .from(prospects)
        .innerJoin(emailMessages, eq(emailMessages.prospectId, prospects.id))
        .where(eq(emailMessages.gmailThreadId, input.gmailThreadId))
        .limit(1)
    )[0]?.prospects ?? null;

  if (!prospect) {
    prospect =
      (
        await db
          .select()
          .from(prospects)
          .where(eq(prospects.emailNormalized, fromEmail))
          .limit(1)
      )[0] ?? null;
  }
  if (!prospect && (cls.classification === "hard_bounce" || cls.classification === "soft_bounce")) {
    const target = bouncedRecipient(input.body);
    if (target) {
      prospect =
        (
          await db.select().from(prospects).where(eq(prospects.emailNormalized, target)).limit(1)
        )[0] ?? null;
    }
  }

  const originalMessage = prospect
    ? (
        await db
          .select()
          .from(emailMessages)
          .where(
            and(
              eq(emailMessages.prospectId, prospect.id),
              eq(emailMessages.status, "sent"),
            ),
          )
          .orderBy(desc(emailMessages.sentAt))
          .limit(1)
      )[0]
    : undefined;

  const phone = extractPhone(input.body);
  const isBounce = cls.classification === "hard_bounce" || cls.classification === "soft_bounce";

  const [reply] = await db
    .insert(replies)
    .values({
      prospectId: prospect?.id ?? null,
      messageId: originalMessage?.id ?? null,
      gmailMessageId: input.gmailMessageId,
      gmailThreadId: input.gmailThreadId,
      fromEmail,
      subject: input.subject,
      bodyText: input.body.slice(0, 8000),
      receivedAt: input.receivedAt,
      classification: cls.classification,
      classifiedBy: cls.by,
      summary: cls.summary,
      suggestedResponse: cls.suggestedResponse,
      extractedPhone: !isBounce && phone ? phone.phone : null,
      extractedPhoneOwnership: !isBounce && phone ? phone.ownership : null,
    })
    .onConflictDoNothing({ target: replies.gmailMessageId })
    .returning();

  if (!reply) return; // duplicate Gmail event: no duplicate record, no duplicate alert

  let followUpStatus = "no pending follow-up";

  if (prospect) {
    // A reply cancels every pending follow-up, immediately.
    const cancelled = await db
      .update(emailMessages)
      .set({
        status: "blocked",
        blockedReason: `cancelled_by_reply:${reply.id}`,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(emailMessages.prospectId, prospect.id),
          eq(emailMessages.kind, "followup"),
          inArray(emailMessages.status, ["queued", "draft", "validated"]),
        ),
      )
      .returning({ id: emailMessages.id });
    followUpStatus =
      cancelled.length > 0
        ? `${cancelled.length} pending follow-up cancelled`
        : "no pending follow-up";

    // Store a newly supplied phone number with source + verification status.
    if (!isBounce && phone && phone.phone !== prospect.phone) {
      await db
        .update(prospects)
        .set({
          suppliedPhone: phone.phone,
          suppliedPhoneSource: `reply ${input.gmailMessageId}`,
          suppliedPhoneVerified: phone.ownership === "stated_by_sender",
          suppliedPhoneAt: input.receivedAt,
          updatedAt: new Date(),
        })
        .where(eq(prospects.id, prospect.id));
    }

    // Deterministic stop rules — never delegated to AI.
    if (cls.classification === "unsubscribe" || cls.classification === "complaint") {
      await suppress({
        email: prospect.email,
        reason: cls.classification === "complaint" ? "complaint" : "unsubscribe",
        sourceRef: `gmail:${input.gmailMessageId}`,
      });
      await transition({
        prospectId: prospect.id,
        to: "UNSUBSCRIBED",
        reason: `Opt-out received (${cls.classification})`,
        extra: { nextAction: "None — permanently suppressed" },
      });
    } else if (cls.classification === "hard_bounce") {
      await suppress({
        email: prospect.email,
        reason: "hard_bounce",
        sourceRef: `gmail:${input.gmailMessageId}`,
      });
      await transition({
        prospectId: prospect.id,
        to: "BOUNCED",
        reason: "Hard bounce received",
        extra: { nextAction: "None — address undeliverable" },
      });
    } else if (cls.classification === "decline") {
      await transition({
        prospectId: prospect.id,
        to: prospect.status === "SENT" ? "REPLIED" : (prospect.status as ProspectState),
        reason: "Decline received",
      });
      await transition({
        prospectId: prospect.id,
        to: "DECLINED",
        reason: "Prospect declined",
        extra: { nextAction: "None — do not contact again" },
      });
    } else if (cls.classification === "soft_bounce" || cls.classification === "auto_reply") {
      // No state change; sequence already stopped by follow-up cancellation.
    } else {
      await transition({
        prospectId: prospect.id,
        to: "REPLIED",
        reason: `Reply received (${cls.classification})`,
        extra: { nextAction: "Operator review in Telegram" },
      });
      if (["interested", "consultation", "pricing"].includes(cls.classification)) {
        await transition({
          prospectId: prospect.id,
          to: "INTERESTED",
          reason: `Classified as ${cls.classification}`,
          extra: { nextAction: "Human response required — do not auto-reply" },
        });

        // Consultation state is recorded from the prospect's own words only.
        const appt = detectAppointment(input.body);
        if (appt) {
          await db.insert(appointments).values({
            prospectId: prospect.id,
            replyId: reply.id,
            status: appt.status,
            evidenceExcerpt: appt.evidenceExcerpt,
            note: `Derived from reply ${input.gmailMessageId}`,
          });
        }

        // Substantive sales replies always require a human. The AI's
        // suggestion is stored as a proposal, never sent automatically.
        await db.insert(approvals).values({
          replyId: reply.id,
          prospectId: prospect.id,
          kind: `respond_${cls.classification}`,
          proposedText: cls.suggestedResponse,
          status: "pending",
        });
      } else {
        await transition({
          prospectId: prospect.id,
          to: "AMBIGUOUS",
          reason: "Reply could not be safely classified",
          extra: { nextAction: "Human classification required" },
        });
      }
    }
  }

  if (ALERT_CLASSIFICATIONS.includes(cls.classification) || reply.extractedPhone) {
    await notifyReply({ reply, prospect, settings: s, followUpStatus });
  }

  await audit({
    actor: "system",
    action: "reply.processed",
    entity: "replies",
    entityId: reply.id,
    detail: { classification: cls.classification, prospectId: prospect?.id ?? null },
  });

  if (STOP_CLASSIFICATIONS.includes(cls.classification)) {
    log.info("sequence_stopped", {
      prospectId: prospect?.id,
      reason: cls.classification,
    });
  }
}

/* ------------------------------------------------------------------ */
/* 6. Follow-up scheduling                                             */
/* ------------------------------------------------------------------ */
export async function scheduleFollowups(): Promise<string> {
  const s = await getSettings();
  const gate = evaluateSendGate(s);
  if (!gate.allowed) return `skipped: ${gate.reasons.join("; ")}`;

  const candidates = await db
    .select()
    .from(prospects)
    .where(eq(prospects.status, "SENT"))
    .limit(50);

  let queued = 0;
  for (const p of candidates) {
    const msgs = await db
      .select()
      .from(emailMessages)
      .where(eq(emailMessages.prospectId, p.id));
    const initial = msgs.find((m) => m.kind === "initial" && m.status === "sent");
    if (!initial?.sentAt) continue;
    if (msgs.some((m) => m.kind === "followup")) continue; // max one follow-up
    const existingReply = await db
      .select({ id: replies.id })
      .from(replies)
      .where(eq(replies.prospectId, p.id))
      .limit(1);
    if (existingReply.length > 0) continue; // any reply stops follow-ups

    const dueAt = addBusinessDays(initial.sentAt, s.followupBusinessDays, s.timezone);
    if (dueAt.getTime() > Date.now()) continue;

    try {
      if (await findSuppression(p.email)) continue;
    } catch {
      continue; // fail closed
    }

    const draft = await composeMessage({ prospect: p, settings: s, isFollowup: true });
    if (!draft.validation.passed) {
      await transition({
        prospectId: p.id,
        to: "REVIEW",
        reason: `Follow-up validation failed: ${draft.validation.issues.map((i) => i.code).join(",")}`,
        extra: { reviewReason: draft.validation.issues.map((i) => i.code).join(",") },
      });
      continue;
    }

    await db
      .insert(emailMessages)
      .values({
        prospectId: p.id,
        kind: "followup",
        subject: draft.subject,
        bodyText: draft.body,
        status: "queued",
        validationReport: draft.validation,
        claimIds: [],
        generator: draft.generator,
        idempotencyKey: stableKey("msg", p.id, "followup"),
        scheduledFor: new Date(Date.now() + pacingJitterMs(`${p.id}-followup`)),
      })
      .onConflictDoNothing({ target: emailMessages.idempotencyKey });
    queued += 1;
  }
  return `followups_queued=${queued}`;
}

/* ------------------------------------------------------------------ */
/* ------------------------------------------------------------------ */
/* 7. Daily PDF report set (no CSV anywhere in the system)             */
/* ------------------------------------------------------------------ */
export async function generateReport(force = false): Promise<string> {
  const s = await getSettings();
  const now = new Date();
  const intervalMs = s.reportIntervalHours * 3600_000;
  const periodStart = s.lastReportAt
    ? new Date(s.lastReportAt)
    : startOfZonedDay(new Date(now.getTime() - intervalMs), s.timezone);

  if (!force && s.lastReportAt && now.getTime() - s.lastReportAt.getTime() < intervalMs)
    return "skipped: interval not elapsed";

  const generated = await generateReportSet(periodStart, now);
  const summaryReport = generated[generated.length - 1];
  const serials = generated.map((g) => g.serial).join(", ");

  // One concise Telegram digest, then each PDF as a document attachment.
  const counts = await reportCounts(periodStart, now);
  const zero = counts.touched === 0;
  await enqueueNotification({
    kind: "report_summary",
    dedupeKey: `report-summary-${summaryReport.fileName}`,
    text:
      `📄 <b>Aurum Bespoke — 24h report</b>\n` +
      `Serials ${esc(serials)}\n` +
      `Period ${esc(periodStart.toISOString().slice(0, 16))} → ${esc(now.toISOString().slice(0, 16))}\n\n` +
      (zero
        ? "No records changed in this period (zero-activity report issued deliberately)."
        : [
            `Professional: ${counts.professional}`,
            `Event planners: ${counts.planners}`,
            `Contacted: ${counts.contacted}`,
            `Replies: ${counts.replies}`,
            `Interested: ${counts.interested}`,
            `Needs review: ${counts.review}`,
          ].join("\n")),
  });

  for (const g of generated) {
    await enqueueNotification({
      kind: "report_pdf",
      dedupeKey: `report-pdf-${g.fileName}`,
      text: g.fileName,
      documentName: g.fileName,
      documentContent: g.pdf,
    });
    await db
      .update(reports)
      .set({ deliveryStatus: "queued_for_delivery" })
      .where(eq(reports.id, g.id));
  }

  await updateSettings({ lastReportAt: now });
  await audit({
    actor: "system",
    action: "report.generated",
    detail: { serials, files: generated.map((g) => g.fileName) },
  });
  return `reports=${generated.length} serials=${serials} records=${counts.touched}`;
}

async function reportCounts(from: Date, to: Date) {
  const touchedRows = await db
    .select({ segment: prospects.segment, status: prospects.status })
    .from(prospects)
    .where(
      or(
        and(gte(prospects.updatedAt, from), lte(prospects.updatedAt, to)),
        and(gte(prospects.createdAt, from), lte(prospects.createdAt, to)),
      ),
    );
  const replyRows = await db
    .select({ n: sql<string>`count(*)` })
    .from(replies)
    .where(and(gte(replies.receivedAt, from), lte(replies.receivedAt, to)));
  const contacted = await db
    .select({ n: sql<string>`count(*)` })
    .from(emailMessages)
    .where(and(eq(emailMessages.status, "sent"), gte(emailMessages.sentAt, from)));
  return {
    touched: touchedRows.length,
    professional: touchedRows.filter((r) => r.segment !== "event_planner").length,
    planners: touchedRows.filter((r) => r.segment === "event_planner").length,
    interested: touchedRows.filter((r) => r.status === "INTERESTED").length,
    review: touchedRows.filter((r) => r.status === "REVIEW").length,
    replies: Number(replyRows[0]?.n ?? 0),
    contacted: Number(contacted[0]?.n ?? 0),
  };
}

/** Marks reports delivered once their Telegram documents have been sent. */
export async function reconcileReportDelivery(): Promise<void> {
  const pending = await db
    .select()
    .from(reports)
    .where(
      or(eq(reports.deliveryStatus, "queued_for_delivery"), eq(reports.deliveryStatus, "pending")),
    )
    .limit(20);
  for (const r of pending) {
    const rows = await db.execute(
      sql`select status from notifications where dedupe_key = ${`report-pdf-${r.fileName}`}`,
    );
    const status = (rows.rows as { status: string }[])[0]?.status;
    if (status === "sent") {
      await db
        .update(reports)
        .set({ deliveryStatus: "delivered", deliveredAt: new Date() })
        .where(eq(reports.id, r.id));
    } else if (status === "dead") {
      await db
        .update(reports)
        .set({
          deliveryStatus: "failed",
          deliveryError: "Telegram delivery dead-lettered; PDF retained in the database",
        })
        .where(eq(reports.id, r.id));
    }
  }
}

/* ------------------------------------------------------------------ */
/* 7b. Adaptive sending budget                                         */
/* ------------------------------------------------------------------ */
export async function recomputeBudget(): Promise<string> {
  const d = await evaluateDailyBudget();
  return d ? `${d.action}: ${d.previous} -> ${d.next} (${d.bindingConstraint})` : "already decided today";
}
/* ------------------------------------------------------------------ */
/* 8. Gmail watch renewal                                              */
/* ------------------------------------------------------------------ */
export async function renewGmailWatch(): Promise<string> {
  if (env.mockMode) return "mock";
  const res = await startWatch();
  if (!res.ok) throw new DependencyJobError(res.detail);
  return res.detail;
}

/* ------------------------------------------------------------------ */
/* Dispatcher                                                          */
/* ------------------------------------------------------------------ */
export async function runJob(type: string, payload: Record<string, unknown>): Promise<string> {
  switch (type) {
    case "verify_prospects":
      return verifyProspects();
    case "promote_eligible":
      return promoteEligible();
    case "draft_and_queue":
      return draftAndQueue();
    case "send_due_messages":
      return sendDueMessages();
    case "poll_replies":
      return pollReplies();
    case "schedule_followups":
      return scheduleFollowups();
    case "generate_report":
      return generateReport(Boolean(payload.force));
    case "recompute_budget":
      return recomputeBudget();
    case "gmail_watch_renew":
      return renewGmailWatch();
    default:
      throw new PermanentJobError(`Unknown job type: ${type}`);
  }
}

/** Convenience used by the dashboard and Telegram "Report Now" button. */
export async function enqueueReportNow(): Promise<void> {
  await enqueueJob({
    type: "generate_report",
    idempotencyKey: `report-manual-${Date.now()}`,
    payload: { force: true },
  });
}

export async function counts() {
  const s = await getSettings();
  const dayStart = startOfZonedDay(new Date(), s.timezone);
  const q = async (table: typeof prospects, state: string) =>
    Number(
      (
        await db
          .select({ n: sql<string>`count(*)` })
          .from(table)
          .where(eq(table.status, state))
      )[0]?.n ?? 0,
    );
  const replies24h = Number(
    (
      await db
        .select({ n: sql<string>`count(*)` })
        .from(replies)
        .where(gte(replies.receivedAt, new Date(Date.now() - 86_400_000)))
    )[0]?.n ?? 0,
  );
  return {
    sentToday: await sentTodayCount(s),
    eligible: await q(prospects, "ELIGIBLE"),
    queued: await q(prospects, "QUEUED"),
    review: await q(prospects, "REVIEW"),
    interested: await q(prospects, "INTERESTED"),
    replies24h,
    dayStart,
  };
}

export { settingsTable, lte, gte, and, eq };
