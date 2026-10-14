import crypto from "node:crypto";
import { db } from "@/db";
import {
  appointments,
  budgetDecisions,
  emailMessages,
  prospects,
  replies,
  reports,
  suppressions,
  type Prospect,
} from "@/db/schema";
import { and, desc, eq, gte, inArray, lte, or, sql } from "drizzle-orm";
import { ReportBuilder, orNA, type Column, type Row } from "./pdf";
import { gmailThreadLink } from "./providers/telegram";
import { formatZoned, zonedParts } from "./time";
import { getSettings } from "./settings";
import { allocateSerial, reportFileName, type ReportType } from "./serial";
import { collectHealthMetrics } from "./budget";

/* ------------------------------------------------------------------ */
/* Row assembly                                                        */
/* ------------------------------------------------------------------ */

export type ProspectRow = Row & {
  sn: string;
  pid: string;
  name: string;
  role: string;
  company: string;
  city: string;
  email: string;
  emailStatus: string;
  phone: string;
  phoneSource: string;
  website: string;
  hook: string;
  evidenceUrl: string;
  score: string;
  status: string;
  lastContact: string;
  replyCategory: string;
  followUp: string;
  appointment: string;
  gmailLink: string;
  notes: string;
};

const PROSPECT_COLUMNS: Column[] = [
  { key: "sn", label: "S/N", width: 22 },
  { key: "pid", label: "ID", width: 28 },
  { key: "name", label: "Name", width: 78 },
  { key: "role", label: "Role", width: 76 },
  { key: "company", label: "Company", width: 80 },
  { key: "email", label: "Email", width: 108 },
  { key: "emailStatus", label: "Email status", width: 50 },
  { key: "phone", label: "Phone", width: 62 },
  { key: "score", label: "Score", width: 32 },
  { key: "status", label: "State", width: 54 },
  { key: "lastContact", label: "Last contact", width: 66 },
  { key: "replyCategory", label: "Reply", width: 48 },
  { key: "followUp", label: "Follow-up", width: 52 },
  { key: "appointment", label: "Appt.", width: 44 },
  { key: "notes", label: "Notes / issues", width: 84 },
];

async function buildProspectRow(p: Prospect, tz: string, index: number): Promise<ProspectRow> {
  const msgs = await db
    .select()
    .from(emailMessages)
    .where(eq(emailMessages.prospectId, p.id))
    .orderBy(desc(emailMessages.id));
  const initial = msgs.find((m) => m.kind === "initial");
  const followup = msgs.find((m) => m.kind === "followup");
  const reply = (
    await db
      .select()
      .from(replies)
      .where(eq(replies.prospectId, p.id))
      .orderBy(desc(replies.receivedAt))
      .limit(1)
  )[0];
  const appt = (
    await db
      .select()
      .from(appointments)
      .where(eq(appointments.prospectId, p.id))
      .orderBy(desc(appointments.id))
      .limit(1)
  )[0];
  const suppression = (
    await db
      .select()
      .from(suppressions)
      .where(eq(suppressions.emailNormalized, p.emailNormalized))
      .limit(1)
  )[0];

  const threadId = reply?.gmailThreadId ?? initial?.gmailThreadId ?? "";
  const lastSent = followup?.sentAt ?? initial?.sentAt ?? null;
  const latest = msgs[0];

  const followUpState = followup
    ? `${followup.kind}:${followup.status}`
    : initial?.status === "sent"
      ? reply
        ? "cancelled (reply)"
        : "scheduled"
      : "none";

  return {
    sn: String(index + 1).padStart(3, "0"),
    pid: `P-${p.id}`,
    name: p.fullName,
    role: orNA(p.role),
    company: orNA(p.company),
    city: p.city,
    email: p.email,
    emailStatus: p.emailStatus,
    phone: p.suppliedPhone ?? p.phone ?? "",
    phoneSource: p.suppliedPhone
      ? `supplied by prospect (${p.suppliedPhoneVerified ? "verified" : "unverified"}) · ${orNA(p.suppliedPhoneSource)}`
      : p.phone
        ? `${p.phoneType ?? "unverified"} · ${orNA(p.phoneSourceUrl)}`
        : "",
    website: orNA(p.website),
    hook: initial?.personalizationHook ?? "",
    evidenceUrl: [p.sourceUrl, p.emailSourceUrl].filter(Boolean).join("  "),
    score: `${p.leadScore}/${p.verificationConfidence}`,
    status: p.status,
    lastContact: lastSent ? formatZoned(new Date(lastSent), tz) : "",
    replyCategory: reply?.classification ?? "",
    followUp: followUpState,
    appointment: appt ? appt.status : "",
    gmailLink: threadId ? gmailThreadLink(threadId) : "",
    notes: [
      p.reviewReason,
      latest?.blockedReason,
      latest?.error,
      suppression ? `suppressed:${suppression.reason}` : null,
    ]
      .filter(Boolean)
      .join(" | "),
  };
}

export type ReportBundle = {
  periodStart: Date;
  periodEnd: Date;
  counts: Record<string, number>;
  professional: ProspectRow[];
  eventPlanner: ProspectRow[];
  /** Everything touched in the window, regardless of segment. */
  all: ProspectRow[];
};

/** Collects every record created or updated inside the reporting window. */
export async function collectData(
  periodStart: Date,
  periodEnd: Date,
): Promise<ReportBundle> {
  const s = await getSettings();
  const tz = s.timezone;

  const touched = await db
    .select()
    .from(prospects)
    .where(
      or(
        and(gte(prospects.updatedAt, periodStart), lte(prospects.updatedAt, periodEnd)),
        and(gte(prospects.createdAt, periodStart), lte(prospects.createdAt, periodEnd)),
      ),
    )
    .orderBy(desc(prospects.leadScore), desc(prospects.updatedAt));

  const professionalSrc = touched.filter((p) => p.segment !== "event_planner");
  const plannerSrc = touched.filter((p) => p.segment === "event_planner");

  const professional: ProspectRow[] = [];
  for (const [i, p] of professionalSrc.entries())
    professional.push(await buildProspectRow(p, tz, i));
  const eventPlanner: ProspectRow[] = [];
  for (const [i, p] of plannerSrc.entries())
    eventPlanner.push(await buildProspectRow(p, tz, i));

  const all = [...professional, ...eventPlanner];
  const counts: Record<string, number> = {
    "Records touched": all.length,
    "Professional segment": professional.length,
    "Event planner segment": eventPlanner.length,
    Contacted: all.filter((r) => r.lastContact).length,
    Replies: all.filter((r) => r.replyCategory).length,
    Interested: all.filter((r) => r.status === "INTERESTED").length,
    "Opt-outs": all.filter((r) => r.notes.includes("suppressed:unsubscribe")).length,
    "Bounces / complaints": all.filter(
      (r) => r.notes.includes("hard_bounce") || r.notes.includes("complaint"),
    ).length,
    "Needs review": all.filter((r) => r.status === "REVIEW" || r.notes).length,
  };

  return { periodStart, periodEnd, counts, professional, eventPlanner, all };
}

/* ------------------------------------------------------------------ */
/* PDF renderers                                                       */
/* ------------------------------------------------------------------ */

type RenderCtx = {
  bundle: ReportBundle;
  tz: string;
  serial: string;
  generatedAt: Date;
};

function detailBlocks(rows: ProspectRow[]) {
  return rows.map((r) => ({
    heading: `${r.sn}  ·  ${r.name}  —  ${orNA(r.company)}  (${r.pid})`,
    fields: [
      ["Role", r.role],
      ["City / segment", `${r.city}`],
      ["Email", `${r.email}  (${r.emailStatus})`],
      ["Business phone", r.phone],
      ["Phone source", r.phoneSource],
      ["Website", r.website],
      ["Personalisation hook", r.hook],
      ["Evidence source URL", r.evidenceUrl],
      ["Lead score / verification confidence", r.score],
      ["Campaign state", r.status],
      ["Last contact", r.lastContact],
      ["Reply category", r.replyCategory],
      ["Follow-up status", r.followUp],
      ["Appointment status", r.appointment],
      ["Gmail conversation", r.gmailLink],
      ["Notes / unresolved issues", r.notes],
    ] as [string, string][],
  }));
}

async function renderProspectReport(
  ctx: RenderCtx,
  title: string,
  rows: ProspectRow[],
  subtitle: string,
): Promise<Buffer> {
  const b = new ReportBuilder({
    serial: ctx.serial,
    title,
    subtitle,
    periodStart: ctx.bundle.periodStart,
    periodEnd: ctx.bundle.periodEnd,
    generatedAt: ctx.generatedAt,
    timezone: ctx.tz,
  });

  b.summary([
    ["Records", rows.length],
    ["Contacted", rows.filter((r) => r.lastContact).length],
    ["Replies", rows.filter((r) => r.replyCategory).length],
    ["Interested", rows.filter((r) => r.status === "INTERESTED").length],
    ["Awaiting review", rows.filter((r) => r.status === "REVIEW").length],
    ["Suppressed", rows.filter((r) => r.notes.includes("suppressed")).length],
    ["Appointments", rows.filter((r) => r.appointment).length],
    ["Avg lead score", rows.length ? Math.round(rows.reduce((a, r) => a + Number(r.score.split("/")[0]), 0) / rows.length) : 0],
  ]);

  b.heading("Prospect index");
  b.paragraph(
    'Score column shows "lead score / verification confidence" (0–100 each). A dash means the value is not available; it is never substituted with an invented value.',
  );
  b.table(PROSPECT_COLUMNS, rows, { emptyText: "No prospects in this segment for the period." });

  if (rows.length > 0) {
    b.heading("Full records");
    b.paragraph("Complete field set per prospect, including source evidence and Gmail conversation links.");
    b.details(detailBlocks(rows));
  }
  return b.finish();
}

async function renderDailyActivity(ctx: RenderCtx): Promise<Buffer> {
  const { bundle, tz } = ctx;
  const b = new ReportBuilder({
    serial: ctx.serial,
    title: "Daily Campaign Activity",
    periodStart: bundle.periodStart,
    periodEnd: bundle.periodEnd,
    generatedAt: ctx.generatedAt,
    timezone: tz,
  });

  const msgs = await db
    .select()
    .from(emailMessages)
    .where(
      and(
        gte(emailMessages.updatedAt, bundle.periodStart),
        lte(emailMessages.updatedAt, bundle.periodEnd),
      ),
    )
    .orderBy(desc(emailMessages.id));

  const decisions = await db
    .select()
    .from(budgetDecisions)
    .orderBy(desc(budgetDecisions.id))
    .limit(7);

  b.summary([
    ["Messages touched", msgs.length],
    ["Sent", msgs.filter((m) => m.status === "sent").length],
    ["Queued", msgs.filter((m) => m.status === "queued").length],
    ["Blocked", msgs.filter((m) => m.status === "blocked").length],
    ["Uncertain", msgs.filter((m) => m.status === "uncertain").length],
    ["AI drafted", msgs.filter((m) => m.generator === "ai").length],
    ["Template drafted", msgs.filter((m) => m.generator === "template").length],
    ["Avg quality", msgs.length ? Math.round(msgs.reduce((a, m) => a + m.qualityScore, 0) / msgs.length) : 0],
  ]);

  b.heading("Messages");
  b.table(
    [
      { key: "id", label: "Msg", width: 26 },
      { key: "pid", label: "Prospect", width: 34 },
      { key: "kind", label: "Kind", width: 34 },
      { key: "status", label: "Status", width: 40 },
      { key: "provider", label: "AI provider", width: 44 },
      { key: "quality", label: "Quality", width: 32 },
      { key: "subject", label: "Subject", width: 150 },
      { key: "hook", label: "Personalisation hook", width: 150 },
      { key: "sent", label: "Sent at", width: 66 },
      { key: "issue", label: "Blocked reason / error", width: 110 },
    ],
    msgs.map((m) => ({
      id: `#${m.id}`,
      pid: `P-${m.prospectId}`,
      kind: m.kind,
      status: m.status,
      provider: m.aiProvider,
      quality: String(m.qualityScore),
      subject: m.subject,
      hook: m.personalizationHook ?? "",
      sent: m.sentAt ? formatZoned(new Date(m.sentAt), tz) : "",
      issue: m.blockedReason ?? m.error ?? "",
    })),
    { emptyText: "No message activity in this period." },
  );

  b.heading("Adaptive sending budget decisions");
  b.paragraph(
    "The daily volume is derived from measured delivery health. Every change records its binding constraint and reason.",
  );
  b.table(
    [
      { key: "day", label: "Day", width: 48 },
      { key: "from", label: "From", width: 28 },
      { key: "to", label: "To", width: 28 },
      { key: "action", label: "Action", width: 40 },
      { key: "binding", label: "Binding constraint", width: 70 },
      { key: "reason", label: "Reason", width: 220 },
    ],
    decisions.map((d) => ({
      day: d.dayKey,
      from: String(d.previousBudget),
      to: String(d.newBudget),
      action: d.action,
      binding: d.bindingConstraint,
      reason: d.reason,
    })),
    { emptyText: "No budget decisions recorded yet." },
  );
  return b.finish();
}

async function renderReplies(ctx: RenderCtx): Promise<Buffer> {
  const { bundle, tz } = ctx;
  const b = new ReportBuilder({
    serial: ctx.serial,
    title: "Replies & Follow-up Status",
    periodStart: bundle.periodStart,
    periodEnd: bundle.periodEnd,
    generatedAt: ctx.generatedAt,
    timezone: tz,
  });

  const rows = await db
    .select()
    .from(replies)
    .where(and(gte(replies.receivedAt, bundle.periodStart), lte(replies.receivedAt, bundle.periodEnd)))
    .orderBy(desc(replies.receivedAt));

  b.summary([
    ["Replies", rows.length],
    ["Interested", rows.filter((r) => r.classification === "interested").length],
    ["Consultation", rows.filter((r) => r.classification === "consultation").length],
    ["Pricing", rows.filter((r) => r.classification === "pricing").length],
    ["Declined", rows.filter((r) => r.classification === "decline").length],
    ["Opt-outs", rows.filter((r) => r.classification === "unsubscribe").length],
    ["Bounces", rows.filter((r) => r.classification.includes("bounce")).length],
    ["Unhandled", rows.filter((r) => !r.handled).length],
  ]);

  b.heading("Inbound replies");
  b.table(
    [
      { key: "when", label: "Received", width: 66 },
      { key: "from", label: "From", width: 110 },
      { key: "pid", label: "Prospect", width: 34 },
      { key: "cls", label: "Classification", width: 56 },
      { key: "by", label: "By", width: 28 },
      { key: "phone", label: "New phone supplied", width: 72 },
      { key: "handled", label: "Handled", width: 36 },
      { key: "summary", label: "Summary / excerpt", width: 200 },
      { key: "link", label: "Gmail thread", width: 130 },
    ],
    rows.map((r) => ({
      when: formatZoned(new Date(r.receivedAt), tz),
      from: r.fromEmail,
      pid: r.prospectId ? `P-${r.prospectId}` : "",
      cls: r.classification,
      by: r.classifiedBy,
      phone: r.extractedPhone
        ? `${r.extractedPhone} (${r.extractedPhoneOwnership === "stated_by_sender" ? "stated" : "unverified"})`
        : "",
      handled: r.handled ? "yes" : "no",
      summary: (r.summary ?? r.bodyText ?? "").replace(/\s+/g, " ").slice(0, 400),
      link: gmailThreadLink(r.gmailThreadId),
    })),
    { emptyText: "No replies received in this period." },
  );
  return b.finish();
}

async function renderAppointments(ctx: RenderCtx): Promise<Buffer> {
  const { bundle, tz } = ctx;
  const b = new ReportBuilder({
    serial: ctx.serial,
    title: "Appointments & Consultations",
    subtitle: "A consultation is only 'confirmed' when the prospect states it explicitly",
    periodStart: bundle.periodStart,
    periodEnd: bundle.periodEnd,
    generatedAt: ctx.generatedAt,
    timezone: tz,
  });

  const rows = await db
    .select({ a: appointments, p: prospects })
    .from(appointments)
    .leftJoin(prospects, eq(appointments.prospectId, prospects.id))
    .orderBy(desc(appointments.updatedAt))
    .limit(300);

  b.summary([
    ["Total", rows.length],
    ["Proposed", rows.filter((r) => r.a.status === "proposed").length],
    ["Awaiting confirmation", rows.filter((r) => r.a.status === "awaiting_confirmation").length],
    ["Confirmed", rows.filter((r) => r.a.status === "confirmed").length],
    ["Rescheduled", rows.filter((r) => r.a.status === "rescheduled").length],
    ["Cancelled", rows.filter((r) => r.a.status === "cancelled").length],
  ]);

  b.heading("Consultation pipeline");
  b.paragraph(
    "Proposed, awaiting confirmation, confirmed, rescheduled and cancelled are tracked as distinct states. A date is recorded only when the prospect supplied one.",
  );
  b.table(
    [
      { key: "pid", label: "Prospect", width: 34 },
      { key: "name", label: "Name", width: 90 },
      { key: "company", label: "Company", width: 90 },
      { key: "status", label: "Status", width: 62 },
      { key: "when", label: "Scheduled for", width: 70 },
      { key: "evidence", label: "Evidence excerpt", width: 220 },
      { key: "updated", label: "Updated", width: 66 },
    ],
    rows.map((r) => ({
      pid: `P-${r.a.prospectId}`,
      name: r.p?.fullName ?? "",
      company: r.p?.company ?? "",
      status: r.a.status,
      when: r.a.scheduledFor ? formatZoned(new Date(r.a.scheduledFor), tz) : "",
      evidence: r.a.evidenceExcerpt ?? "",
      updated: formatZoned(new Date(r.a.updatedAt), tz),
    })),
    { emptyText: "No consultation enquiries recorded." },
  );
  return b.finish();
}

async function renderDeliverability(ctx: RenderCtx): Promise<Buffer> {
  const { bundle, tz } = ctx;
  const s = await getSettings();
  const metrics = await collectHealthMetrics();
  const b = new ReportBuilder({
    serial: ctx.serial,
    title: "Deliverability, Suppression & Errors",
    periodStart: bundle.periodStart,
    periodEnd: bundle.periodEnd,
    generatedAt: ctx.generatedAt,
    timezone: tz,
  });

  b.summary([
    [`Sent (${metrics.windowDays}d)`, metrics.sent],
    ["Hard bounces", metrics.hardBounces],
    ["Complaints", metrics.complaints],
    ["Opt-outs", metrics.optOuts],
    ["Bounce rate", `${(metrics.bounceRate * 100).toFixed(2)}%`],
    ["Complaint rate", `${(metrics.complaintRate * 100).toFixed(2)}%`],
    ["Opt-out rate", `${(metrics.optOutRate * 100).toFixed(2)}%`],
    ["Positive reply rate", `${(metrics.positiveRate * 100).toFixed(2)}%`],
  ]);

  b.heading("Current sending configuration");
  b.table(
    [
      { key: "k", label: "Setting", width: 150 },
      { key: "v", label: "Value", width: 100 },
      { key: "n", label: "Note", width: 300 },
    ],
    [
      { k: "Adaptive daily budget", v: String(s.currentDailyBudget), n: "Recomputed daily from measured delivery health" },
      { k: "Budget floor", v: String(s.budgetFloor), n: "Conservative starting volume" },
      { k: "Operator ceiling", v: String(s.budgetCeiling), n: "Hard cap the controller may never exceed" },
      { k: "Operator-verified provider limit", v: String(s.providerDailyLimit), n: "Must be confirmed against the actual Gmail account; not asserted by this system" },
      { k: "Growth step", v: `${s.budgetGrowthPct}%`, n: "Applied at most once per 24h, only on clean metrics" },
      { k: "Sending enabled", v: s.sendingEnabled ? "yes" : "no", n: s.budgetPausedReason ?? "" },
      { k: "Emergency stop", v: s.emergencyStop ? "ACTIVE" : "off", n: "Blocks all new outbound email" },
    ],
  );

  const sup = await db.select().from(suppressions).orderBy(desc(suppressions.createdAt)).limit(400);
  b.heading("Global suppression list");
  b.paragraph("Shared across the professional and event-planner segments. Entries are permanent.");
  b.table(
    [
      { key: "email", label: "Email", width: 160 },
      { key: "reason", label: "Reason", width: 70 },
      { key: "src", label: "Source reference", width: 140 },
      { key: "when", label: "Added", width: 80 },
    ],
    sup.map((x) => ({
      email: x.emailNormalized,
      reason: x.reason,
      src: x.sourceRef ?? "",
      when: formatZoned(new Date(x.createdAt), tz),
    })),
    { emptyText: "Suppression list is empty." },
  );

  const failed = await db
    .select()
    .from(emailMessages)
    .where(inArray(emailMessages.status, ["blocked", "failed", "uncertain"]))
    .orderBy(desc(emailMessages.id))
    .limit(200);
  b.heading("Blocked, failed and uncertain messages");
  b.table(
    [
      { key: "id", label: "Msg", width: 26 },
      { key: "pid", label: "Prospect", width: 34 },
      { key: "kind", label: "Kind", width: 36 },
      { key: "status", label: "Status", width: 44 },
      { key: "quality", label: "Quality", width: 32 },
      { key: "reason", label: "Reason", width: 280 },
    ],
    failed.map((m) => ({
      id: `#${m.id}`,
      pid: `P-${m.prospectId}`,
      kind: m.kind,
      status: m.status,
      quality: String(m.qualityScore),
      reason: m.blockedReason ?? m.error ?? "",
    })),
    { emptyText: "No blocked or failed messages." },
  );
  return b.finish();
}

async function renderExecutiveSummary(ctx: RenderCtx, serials: string[]): Promise<Buffer> {
  const { bundle, tz } = ctx;
  const s = await getSettings();
  const metrics = await collectHealthMetrics();
  const b = new ReportBuilder({
    serial: ctx.serial,
    title: "Daily Executive Summary",
    periodStart: bundle.periodStart,
    periodEnd: bundle.periodEnd,
    generatedAt: ctx.generatedAt,
    timezone: tz,
  });

  b.summary([
    ["Records touched", bundle.counts["Records touched"] ?? 0],
    ["Professional", bundle.counts["Professional segment"] ?? 0],
    ["Event planners", bundle.counts["Event planner segment"] ?? 0],
    ["Contacted", bundle.counts["Contacted"] ?? 0],
    ["Replies", bundle.counts["Replies"] ?? 0],
    ["Interested", bundle.counts["Interested"] ?? 0],
    ["Opt-outs", bundle.counts["Opt-outs"] ?? 0],
    ["Needs review", bundle.counts["Needs review"] ?? 0],
  ]);

  if ((bundle.counts["Records touched"] ?? 0) === 0) {
    b.heading("Zero-activity period");
    b.paragraph(
      "No prospect records were created or updated during this reporting period. This report is issued deliberately rather than skipped, so that a silent failure can never be mistaken for a quiet day.",
    );
  }

  b.heading("Operating state");
  b.table(
    [
      { key: "k", label: "Item", width: 150 },
      { key: "v", label: "Value", width: 90 },
      { key: "n", label: "Note", width: 300 },
    ],
    [
      { k: "Sending", v: s.emergencyStop ? "EMERGENCY STOP" : s.sendingEnabled ? "enabled" : "paused", n: s.budgetPausedReason ?? "" },
      { k: "Adaptive daily budget", v: String(s.currentDailyBudget), n: `ceiling ${s.budgetCeiling} · provider limit ${s.providerDailyLimit}` },
      { k: "Bounce rate", v: `${(metrics.bounceRate * 100).toFixed(2)}%`, n: "14-day window" },
      { k: "Complaint rate", v: `${(metrics.complaintRate * 100).toFixed(2)}%`, n: "14-day window" },
      { k: "Positive reply rate", v: `${(metrics.positiveRate * 100).toFixed(2)}%`, n: "14-day window" },
      { k: "Eligible pool", v: String(metrics.eligiblePool), n: "Prospects cleared for outreach" },
    ],
  );

  b.heading("Reports issued in this cycle");
  b.table(
    [
      { key: "serial", label: "Serial", width: 40 },
      { key: "file", label: "File", width: 260 },
    ],
    serials.map((f) => ({ serial: f.slice(0, 3), file: f })),
  );

  const attention = bundle.all.filter((r) => r.status === "REVIEW" || r.notes);
  b.heading("Requires attention");
  b.table(
    [
      { key: "pid", label: "Prospect", width: 34 },
      { key: "name", label: "Name", width: 100 },
      { key: "status", label: "State", width: 56 },
      { key: "notes", label: "Issue", width: 300 },
    ],
    attention.map((r) => ({ pid: r.pid, name: r.name, status: r.status, notes: r.notes })),
    { emptyText: "Nothing requires human attention." },
  );
  return b.finish();
}

/* ------------------------------------------------------------------ */
/* Orchestration                                                       */
/* ------------------------------------------------------------------ */

export type GeneratedReport = {
  id: number;
  serial: string;
  fileName: string;
  reportType: ReportType;
  pdf: Buffer;
};

/**
 * Generates the full PDF report set. Each file gets its own durable serial.
 * No CSV or spreadsheet output exists anywhere in the system.
 */
export async function generateReportSet(
  periodStart: Date,
  periodEnd: Date,
): Promise<GeneratedReport[]> {
  const s = await getSettings();
  const tz = s.timezone;
  const generatedAt = new Date();
  const dateKey = zonedParts(generatedAt, tz).dateKey;
  const bundle = await collectData(periodStart, periodEnd);

  type Spec = {
    type: ReportType;
    segment: string | null;
    render: (ctx: RenderCtx) => Promise<Buffer>;
    counts: Record<string, number>;
  };

  const specs: Spec[] = [
    {
      type: "main_prospects",
      segment: "professional",
      counts: { records: bundle.professional.length },
      render: (ctx) =>
        renderProspectReport(
          ctx,
          "Main Prospect Report — Business & Professional",
          bundle.professional,
          "Professional segment only; event planners are reported separately",
        ),
    },
    {
      type: "event_planners",
      segment: "event_planner",
      counts: { records: bundle.eventPlanner.length },
      render: (ctx) =>
        renderProspectReport(
          ctx,
          "Event & Wedding Planner Report",
          bundle.eventPlanner,
          "Independent segment with its own queue, qualification and campaign history",
        ),
    },
    { type: "daily_activity", segment: null, counts: bundle.counts, render: renderDailyActivity },
    { type: "replies", segment: null, counts: bundle.counts, render: renderReplies },
    { type: "appointments", segment: null, counts: bundle.counts, render: renderAppointments },
    { type: "deliverability", segment: null, counts: bundle.counts, render: renderDeliverability },
  ];

  const out: GeneratedReport[] = [];
  const fileNames: string[] = [];

  for (const spec of specs) {
    const alloc = await allocateSerial();
    const fileName = reportFileName(alloc, spec.type, dateKey);
    const ctx: RenderCtx = { bundle, tz, serial: alloc.padded, generatedAt };
    const pdf = await spec.render(ctx);
    const id = await persistReport({
      alloc,
      fileName,
      reportType: spec.type,
      segment: spec.segment,
      periodStart,
      periodEnd,
      counts: spec.counts,
      pdf,
    });
    fileNames.push(fileName);
    out.push({ id, serial: alloc.padded, fileName, reportType: spec.type, pdf });
  }

  // The executive summary is issued last so it can list the other serials.
  const alloc = await allocateSerial();
  const fileName = reportFileName(alloc, "executive_summary", dateKey);
  const pdf = await renderExecutiveSummary(
    { bundle, tz, serial: alloc.padded, generatedAt },
    fileNames,
  );
  const id = await persistReport({
    alloc,
    fileName,
    reportType: "executive_summary",
    segment: null,
    periodStart,
    periodEnd,
    counts: bundle.counts,
    pdf,
  });
  out.push({ id, serial: alloc.padded, fileName, reportType: "executive_summary", pdf });

  return out;
}

async function persistReport(opts: {
  alloc: { serial: number; cycle: number; padded: string };
  fileName: string;
  reportType: ReportType;
  segment: string | null;
  periodStart: Date;
  periodEnd: Date;
  counts: Record<string, number>;
  pdf: Buffer;
}): Promise<number> {
  const checksum = crypto.createHash("sha256").update(opts.pdf).digest("hex");
  const [row] = await db
    .insert(reports)
    .values({
      reportKey: opts.fileName.replace(/\.pdf$/, ""),
      serial: opts.alloc.serial,
      cycle: opts.alloc.cycle,
      reportType: opts.reportType,
      segment: opts.segment,
      fileName: opts.fileName,
      periodStart: opts.periodStart,
      periodEnd: opts.periodEnd,
      counts: opts.counts,
      pdfContent: opts.pdf,
      checksum,
      byteSize: opts.pdf.length,
      deliveryStatus: "pending",
    })
    .returning({ id: reports.id });
  return row.id;
}

export async function latestReports(limit = 14) {
  return db
    .select({
      id: reports.id,
      serial: reports.serial,
      cycle: reports.cycle,
      fileName: reports.fileName,
      reportType: reports.reportType,
      segment: reports.segment,
      generatedAt: reports.generatedAt,
      counts: reports.counts,
      checksum: reports.checksum,
      byteSize: reports.byteSize,
      deliveryStatus: reports.deliveryStatus,
      deliveredAt: reports.deliveredAt,
      deliveryError: reports.deliveryError,
    })
    .from(reports)
    .orderBy(desc(reports.generatedAt), desc(reports.id))
    .limit(limit);
}

export async function reportCount(): Promise<number> {
  const rows = await db.select({ n: sql<string>`count(*)` }).from(reports);
  return Number(rows[0]?.n ?? 0);
}
