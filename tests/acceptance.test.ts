import test from "node:test";
import assert from "node:assert/strict";
import {
  resetAll,
  seedProspect,
  pushInbound,
  mockStore,
  db,
  sql,
  TEST_NOW,
} from "./helpers";
import { eq } from "drizzle-orm";
import {
  prospects,
  emailMessages,
  replies,
  suppressions,
  notifications,
  jobs,
  reports,
  appointments,
  approvals,
  settings as settingsTable,
} from "../src/db/schema";
import {
  verifyProspects,
  promoteEligible,
  draftAndQueue,
  sendDueMessages,
  pollReplies,
  scheduleFollowups,
  generateReport,
  reconcileReportDelivery,
} from "../src/lib/jobs/handlers";
import { getSettings, updateSettings, evaluateSendGate } from "../src/lib/settings";
import { ingestProspects } from "../src/lib/discovery";
import { validateDraft } from "../src/lib/validate";
import { checkEligibility } from "../src/lib/eligibility";
import { flushNotifications, gmailThreadLink } from "../src/lib/providers/telegram";
import { collectData, generateReportSet } from "../src/lib/report";
import { allocateSerial, reportFileName } from "../src/lib/serial";
import { computeBudget, collectHealthMetrics, evaluateDailyBudget } from "../src/lib/budget";
import { deterministicQuality, scoreLead } from "../src/lib/quality";
import { isSuppressed } from "../src/lib/suppression";
import { canTransition } from "../src/lib/state";
import { redact } from "../src/lib/log";
import {
  aiComplete,
  AiUnavailableError,
  AiBudgetExceededError,
  budgetStatus,
  resetBreakers,
} from "../src/lib/providers/ai";
import { enqueueJob, claimNextJob } from "../src/lib/jobs/queue";
import { composeMessage } from "../src/lib/compose";
import { extractPhone, deterministicClassify, detectAppointment } from "../src/lib/classify";
import { runPreflight } from "../src/lib/preflight";

/** Drives the pipeline from DISCOVERED to a sent email. */
async function runToSend() {
  await verifyProspects();
  await promoteEligible();
  await draftAndQueue();
  return sendDueMessages(TEST_NOW);
}

test("01 · duplicate prospects cannot enter overlapping sequences", async () => {
  await resetAll();
  const { input } = await seedProspect();
  const second = await ingestProspects([input]);
  assert.equal(second.created, 0);
  assert.equal(second.duplicates, 1);

  await runToSend();
  // A second draft pass must not create another initial sequence.
  await draftAndQueue();
  const msgs = await db.select().from(emailMessages);
  assert.equal(msgs.filter((m) => m.kind === "initial" && m.status !== "blocked").length, 1);
});

test("02 · an unverified email cannot be sent", async () => {
  await resetAll();
  await seedProspect();
  await db.update(prospects).set({ emailStatus: "unverified", emailVerifiedAt: null });
  await verifyProspects();
  const [p] = await db.select().from(prospects);
  assert.equal(p.status, "REVIEW");

  const s = await getSettings();
  const elig = await checkEligibility(p, s);
  assert.equal(elig.eligible, false);
  assert.ok(elig.blockers.some((b) => b.includes("not source-verified")));

  await draftAndQueue();
  const sent = await sendDueMessages(TEST_NOW);
  assert.ok(!sent.startsWith("sent=1"));
  assert.equal(mockStore().sent.length, 0);
});

test("03 · a missing business phone blocks live sending", async () => {
  await resetAll();
  await updateSettings({ businessPhone: null, businessPhoneVerified: false });
  await seedProspect();
  const s = await getSettings();
  assert.equal(evaluateSendGate(s).allowed, false);

  await verifyProspects();
  await promoteEligible();
  await draftAndQueue();
  const result = await sendDueMessages(TEST_NOW);
  assert.ok(result.startsWith("blocked:"));
  assert.equal(mockStore().sent.length, 0);
});

test("04 · a fabricated or unsupported personalization claim is rejected", async () => {
  await resetAll();
  const s = await getSettings();
  const report = validateDraft(
    {
      subject: "Made-to-measure formalwear in Bengaluru",
      body:
        "Hello Rohan,\n\nCongratulations on your recent Forbes 30 Under 30 award and the Series B raise.\n\n" +
        "Aurum Bespoke makes made-to-measure suits in Bengaluru with fittings around your schedule and a confirmed delivery date for every order placed.\n\n" +
        'If you would prefer no further emails, reply with "UNSUBSCRIBE" and I will remove you immediately.\n\n' +
        "—\nAurum Bespoke\nhttps://aurumbespoke.com\nPhone: +918040001234\n",
      personalizationSentence:
        "Congratulations on your recent Forbes 30 Under 30 award and the Series B raise.",
      claimIds: [1],
      recipientEmail: "rohan@example.com",
    },
    s,
    [
      {
        id: 1,
        claimText: "Rohan Mehta is Managing Director at Mehta Advisory LLP",
        sourceUrl: "https://example.com/team/rohan-mehta",
        excerpt: "Rohan Mehta is Managing Director at Mehta Advisory LLP in Bengaluru.",
        verified: true,
        retrievedAt: new Date(),
      },
    ],
  );
  assert.equal(report.passed, false);
  const codes = report.issues.map((i) => i.code);
  assert.ok(codes.includes("UNVERIFIABLE_CONGRATULATION"));
  assert.ok(codes.includes("UNSUPPORTED_CLAIM_TOKENS"));
});

test("05 · a missing website or opt-out instruction blocks sending", async () => {
  await resetAll();
  const s = await getSettings();
  const base = {
    subject: "Made-to-measure formalwear in Bengaluru",
    personalizationSentence: null,
    claimIds: [] as number[],
    recipientEmail: "rohan@example.com",
  };
  const noWebsite = validateDraft(
    {
      ...base,
      body:
        "Hello Rohan,\n\nAurum Bespoke makes made-to-measure suits in Bengaluru with fittings arranged around your schedule and a confirmed delivery date.\n\n" +
        'If you would prefer no further emails, reply with "UNSUBSCRIBE".\n\n—\nAurum Bespoke\nPhone: +918040001234\n',
    },
    s,
    [],
  );
  assert.ok(noWebsite.issues.some((i) => i.code === "MISSING_WEBSITE"));

  const noOptOut = validateDraft(
    {
      ...base,
      body:
        "Hello Rohan,\n\nAurum Bespoke makes made-to-measure suits in Bengaluru with fittings arranged around your schedule and a confirmed delivery date.\n\n" +
        "—\nAurum Bespoke\nhttps://aurumbespoke.com\nPhone: +918040001234\n",
    },
    s,
    [],
  );
  assert.ok(noOptOut.issues.some((i) => i.code === "MISSING_OPT_OUT"));

  const placeholder = validateDraft(
    {
      ...base,
      body:
        "Hello {{firstName}},\n\nAurum Bespoke makes made-to-measure suits in Bengaluru with fittings arranged around your schedule and a confirmed delivery date.\n\n" +
        'If you would prefer no further emails, reply with "UNSUBSCRIBE".\n\n—\nAurum Bespoke\nhttps://aurumbespoke.com\nPhone: +918040001234\n',
    },
    s,
    [],
  );
  assert.ok(placeholder.issues.some((i) => i.code === "UNRESOLVED_PLACEHOLDER"));
});

test("06 · a reply immediately cancels pending follow-ups", async () => {
  await resetAll();
  const { prospect } = await seedProspect();
  await runToSend();
  const pid = Number(prospect.id);

  // Backdate the initial send so the follow-up becomes due.
  await db
    .update(emailMessages)
    .set({ sentAt: new Date(Date.now() - 20 * 86_400_000) })
    .where(eq(emailMessages.prospectId, pid));
  await scheduleFollowups();
  const pendingFollowups = (await db.select().from(emailMessages)).filter(
    (m) => m.kind === "followup" && m.status === "queued",
  );
  assert.equal(pendingFollowups.length, 1);

  const sentMsg = mockStore().sent[0];
  pushInbound({
    id: "in-reply-1",
    threadId: sentMsg.threadId,
    from: `Rohan Mehta <${String(prospect.email)}>`,
    subject: `Re: ${sentMsg.subject}`,
    body: "This sounds good, I am interested. Please share availability.",
  });
  await pollReplies();

  const after = (await db.select().from(emailMessages)).filter((m) => m.kind === "followup");
  assert.equal(after[0].status, "blocked");
  assert.ok(after[0].blockedReason?.startsWith("cancelled_by_reply"));

  // And no further follow-up may be created.
  await scheduleFollowups();
  const all = (await db.select().from(emailMessages)).filter((m) => m.kind === "followup");
  assert.equal(all.length, 1);
});

test("07 · an opt-out permanently suppresses the address", async () => {
  await resetAll();
  const { prospect } = await seedProspect();
  await runToSend();
  const sentMsg = mockStore().sent[0];

  pushInbound({
    id: "in-optout-1",
    threadId: sentMsg.threadId,
    from: String(prospect.email),
    subject: "Re: outreach",
    body: "Please unsubscribe me and do not email again.",
  });
  await pollReplies();

  assert.ok(await isSuppressed(String(prospect.email)));
  const [p] = await db.select().from(prospects).where(eq(prospects.id, Number(prospect.id)));
  assert.equal(p.status, "UNSUBSCRIBED");

  // Terminal state cannot be reversed by the system or by AI.
  assert.equal(canTransition("UNSUBSCRIBED", "ELIGIBLE", "system"), false);
  assert.equal(canTransition("UNSUBSCRIBED", "ELIGIBLE", "human"), false);
  assert.equal(canTransition("SENT", "REPLIED", "ai"), false);

  // Re-ingesting the same address is refused.
  const reingest = await ingestProspects([
    {
      fullName: "Rohan Mehta",
      role: "Managing Director",
      email: String(prospect.email),
      emailSourceUrl: "https://example.com/x",
      sourceUrl: "https://example.com/x",
      qualificationReason: "test",
    },
  ]);
  assert.equal(reingest.created, 0);
  assert.ok(reingest.rejected[0].reason.includes("suppression"));
});

test("08 · a hard bounce stops the sequence", async () => {
  await resetAll();
  const { prospect } = await seedProspect();
  await runToSend();
  const sentMsg = mockStore().sent[0];

  pushInbound({
    id: "in-bounce-1",
    threadId: sentMsg.threadId,
    from: "Mail Delivery Subsystem <mailer-daemon@googlemail.com>",
    subject: "Delivery Status Notification (Failure)",
    body: `Final-Recipient: rfc822; ${String(prospect.email)}\nDiagnostic-Code: smtp; 550 5.1.1 The email account that you tried to reach does not exist.`,
  });
  await pollReplies();

  const [p] = await db.select().from(prospects).where(eq(prospects.id, Number(prospect.id)));
  assert.equal(p.status, "BOUNCED");
  const sup = await db.select().from(suppressions);
  assert.equal(sup[0].reason, "hard_bounce");

  await scheduleFollowups();
  const followups = (await db.select().from(emailMessages)).filter((m) => m.kind === "followup");
  assert.equal(followups.length, 0);
});

test("09 · duplicate Gmail notifications create no duplicate records or alerts", async () => {
  await resetAll();
  const { prospect } = await seedProspect();
  await runToSend();
  const sentMsg = mockStore().sent[0];

  pushInbound({
    id: "in-dup-1",
    threadId: sentMsg.threadId,
    from: String(prospect.email),
    subject: "Re: outreach",
    body: "Interested, what are the next steps?",
  });
  await pollReplies();
  await pollReplies(); // same Gmail event delivered again
  await pollReplies();

  const allReplies = await db.select().from(replies);
  assert.equal(allReplies.length, 1);
  const alerts = (await db.select().from(notifications)).filter((n) => n.kind === "reply");
  assert.equal(alerts.length, 1);
});

test("10 · a newly supplied phone number is stored with source and verification status", async () => {
  await resetAll();
  const { prospect } = await seedProspect();
  await runToSend();
  const sentMsg = mockStore().sent[0];

  pushInbound({
    id: "in-phone-1",
    threadId: sentMsg.threadId,
    from: String(prospect.email),
    subject: "Re: outreach",
    body: "Interested. You can call me on my mobile 9845012345 after 6pm.",
  });
  await pollReplies();

  const [p] = await db.select().from(prospects).where(eq(prospects.id, Number(prospect.id)));
  assert.equal(p.suppliedPhone, "+919845012345");
  assert.equal(p.suppliedPhoneVerified, true);
  assert.ok(p.suppliedPhoneSource?.includes("in-phone-1"));

  // Ownership that is not established stays unverified.
  const uncertain = extractPhone("Our office line is 080 4000 1234 for general queries.");
  assert.equal(uncertain?.ownership, "uncertain");
});

test("11 · Telegram notifications contain the correct Gmail thread link", async () => {
  await resetAll();
  const { prospect } = await seedProspect();
  await runToSend();
  const sentMsg = mockStore().sent[0];

  pushInbound({
    id: "in-link-1",
    threadId: sentMsg.threadId,
    from: String(prospect.email),
    subject: "Re: outreach",
    body: "Interested, please share pricing.",
  });
  await pollReplies();

  const [alert] = (await db.select().from(notifications)).filter((n) => n.kind === "reply");
  const markup = alert.replyMarkup as { inline_keyboard: { text: string; url?: string }[][] };
  const link = markup.inline_keyboard[0][0].url;
  assert.equal(link, gmailThreadLink(sentMsg.threadId));
  assert.equal(link, `https://mail.google.com/mail/u/0/#all/${sentMsg.threadId}`);

  const [storedReply] = await db.select().from(replies);
  assert.equal(storedReply.gmailThreadId, sentMsg.threadId);
  assert.ok(alert.text.includes("Rohan Mehta"));
  assert.ok(!alert.text.includes("TELEGRAM_BOT_TOKEN"));
});

test("12 · PDF reports contain the expected records and fields", async () => {
  await resetAll();
  await seedProspect();
  await runToSend();

  const data = await collectData(new Date(Date.now() - 3600_000), new Date());
  assert.equal(data.professional.length, 1);
  const row = data.professional[0];
  assert.equal(row.name, "Rohan Mehta");
  assert.equal(row.sn, "001");
  assert.ok(row.lastContact.length > 0);
  assert.ok(row.gmailLink.startsWith("https://mail.google.com/mail/u/0/#all/"));

  const set = await generateReportSet(new Date(Date.now() - 3600_000), new Date());
  // Seven distinct PDF reports, each a real PDF.
  assert.equal(set.length, 7);
  for (const r of set) {
    assert.equal(r.pdf.subarray(0, 4).toString("latin1"), "%PDF");
    assert.ok(r.pdf.length > 1000, `${r.fileName} is too small to be a real report`);
    assert.ok(r.fileName.endsWith(".pdf"));
  }
  const types = set.map((r) => r.reportType);
  for (const t of [
    "main_prospects",
    "event_planners",
    "daily_activity",
    "replies",
    "appointments",
    "deliverability",
    "executive_summary",
  ]) {
    assert.ok(types.includes(t as (typeof types)[number]), `missing report ${t}`);
  }

  // No CSV or spreadsheet output exists anywhere.
  const stored = await db.select().from(reports);
  assert.equal(stored.length, 7);
  assert.ok(stored.every((r) => r.fileName.endsWith(".pdf")));
  assert.ok(stored.every((r) => (r.checksum ?? "").length === 64));
  assert.ok(stored.every((r) => (r.byteSize ?? 0) > 1000));
});

test("12b · event planners are reported separately from the main segment", async () => {
  await resetAll();
  await seedProspect({ fullName: "Rohan Mehta", role: "Managing Director" });
  await seedProspect({
    fullName: "Anita Rao",
    role: "Wedding Planner",
    company: "Saffron Weddings",
    segment: "event_planner",
    qualificationReason: "Runs a Bengaluru wedding planning studio.",
    claims: [
      {
        claimText: "Anita Rao runs Saffron Weddings in Bengaluru",
        sourceUrl: "https://example.com/saffron",
        excerpt: "Anita Rao runs Saffron Weddings in Bengaluru.",
      },
    ],
  });

  const data = await collectData(new Date(Date.now() - 3600_000), new Date());
  assert.equal(data.professional.length, 1);
  assert.equal(data.eventPlanner.length, 1);
  assert.equal(data.professional[0].name, "Rohan Mehta");
  assert.equal(data.eventPlanner[0].name, "Anita Rao");
  // The planner must not appear in the professional set, and vice versa.
  assert.ok(!data.professional.some((r) => r.name === "Anita Rao"));
  assert.ok(!data.eventPlanner.some((r) => r.name === "Rohan Mehta"));

  const set = await generateReportSet(new Date(Date.now() - 3600_000), new Date());
  const main = set.find((r) => r.reportType === "main_prospects")!;
  const planners = set.find((r) => r.reportType === "event_planners")!;
  assert.ok(main.fileName.includes("MAIN_PROSPECTS"));
  assert.ok(planners.fileName.includes("EVENT_PLANNERS"));
  assert.notEqual(main.serial, planners.serial);
});

test("12c · report serials are durable, unique and roll over safely", async () => {
  await resetAll();
  // Concurrent allocation must never produce a duplicate.
  const batch = await Promise.all(Array.from({ length: 25 }, () => allocateSerial()));
  const seen = new Set(batch.map((b) => `${b.cycle}:${b.serial}`));
  assert.equal(seen.size, 25);
  assert.deepEqual(
    batch.map((b) => b.serial).sort((a, b) => a - b),
    Array.from({ length: 25 }, (_, i) => i + 1),
  );
  assert.equal(batch[0].padded, "001");

  // Rollover: 999 -> 001 with the cycle incremented, so archive identity holds.
  await db.execute(sql`update report_counter set last_serial = 998, cycle = 1 where id = 1`);
  const a = await allocateSerial();
  assert.equal(a.padded, "999");
  assert.equal(a.cycle, 1);
  const b = await allocateSerial();
  assert.equal(b.padded, "001");
  assert.equal(b.cycle, 2);
  // Filenames stay distinct across the rollover boundary.
  assert.notEqual(
    reportFileName(a, "main_prospects", "2026-03-11"),
    reportFileName(b, "main_prospects", "2026-03-11"),
  );
  assert.ok(reportFileName(b, "main_prospects", "2026-03-11").includes("_c2"));

  // The counter survives a simulated restart (it lives in PostgreSQL).
  const persisted = await db.execute(sql`select last_serial, cycle from report_counter where id = 1`);
  assert.equal((persisted.rows[0] as { last_serial: number }).last_serial, 1);
});

test("13 · a report is generated after the configured 24-hour interval", async () => {
  await resetAll();
  await seedProspect();

  await updateSettings({ lastReportAt: new Date(Date.now() - 2 * 3600_000) });
  assert.equal(await generateReport(), "skipped: interval not elapsed");

  await updateSettings({ lastReportAt: new Date(Date.now() - 25 * 3600_000) });
  const out = await generateReport();
  assert.ok(out.startsWith("reports=7"));

  const stored = await db.select().from(reports);
  assert.equal(stored.length, 7);
  const docs = (await db.select().from(notifications)).filter((n) => n.kind === "report_pdf");
  assert.equal(docs.length, 7);
  const summary = (await db.select().from(notifications)).filter((n) => n.kind === "report_summary");
  assert.equal(summary.length, 1);
});

test("13b · a zero-activity period still produces a report", async () => {
  await resetAll();
  await updateSettings({ lastReportAt: new Date(Date.now() - 25 * 3600_000) });
  const out = await generateReport();
  assert.ok(out.includes("records=0"));
  const summary = (await db.select().from(notifications)).find((n) => n.kind === "report_summary");
  assert.ok(summary?.text.includes("zero-activity"));
  // The PDFs are still produced and still consume serials.
  assert.equal((await db.select().from(reports)).length, 7);
});

test("14 · a Telegram failure does not lose the report or reply notification", async () => {
  await resetAll();
  await updateSettings({ lastReportAt: new Date(Date.now() - 25 * 3600_000) });
  mockStore().failTelegram = true;
  await generateReport();

  let delivered = await flushNotifications(20);
  assert.equal(delivered, 0);
  let pending = (await db.select().from(notifications)).filter((n) => n.status !== "sent");
  assert.equal(pending.length, 8); // 1 summary + 7 PDFs
  assert.ok(pending.every((n) => n.attempts === 1 && n.lastError));

  // Reports are retained and never falsely marked delivered.
  const stored = await db.select().from(reports);
  assert.ok(stored.every((r) => r.deliveryStatus !== "delivered"));
  assert.ok(stored.every((r) => (r.pdfContent?.length ?? 0) > 1000));

  mockStore().failTelegram = false;
  await db.execute(sql`update notifications set next_attempt_at = now() - interval '1 minute'`);
  delivered = await flushNotifications(20);
  assert.equal(delivered, 8);
  pending = (await db.select().from(notifications)).filter((n) => n.status !== "sent");
  assert.equal(pending.length, 0);

  await reconcileReportDelivery();
  const after = await db.select().from(reports);
  assert.ok(after.every((r) => r.deliveryStatus === "delivered"));
});

test("15 · an AI timeout or spending limit pauses AI-dependent work safely", async () => {
  await resetAll();
  mockStore().failGrok = "timeout";
  mockStore().failGemini = "timeout";
  await assert.rejects(
    () => aiComplete({ task: "classify_reply", messages: [{ role: "user", content: "hello" }] }),
    AiUnavailableError,
  );

  // Drafting falls back to the deterministic approved template, which must
  // still pass validation and the quality gate on its own merits.
  const { prospect } = await seedProspect();
  await verifyProspects();
  await promoteEligible();
  const s = await getSettings();
  const [p] = await db.select().from(prospects).where(eq(prospects.id, Number(prospect.id)));
  const draft = await composeMessage({ prospect: p, settings: s, isFollowup: false });
  assert.equal(draft.generator, "template");
  assert.equal(draft.provider, "template");
  assert.equal(draft.personalizationSentence, null);
  assert.equal(draft.validation.passed, true);

  // Combined ceiling suspends new AI calls immediately.
  resetBreakers();
  mockStore().failGrok = false;
  mockStore().failGemini = false;
  // numeric(10,4) is the storage precision, so use a cap the ledger can hold.
  await updateSettings({ aiDailyCapUsd: "0.0001" });
  for (let i = 0; i < 3; i++) {
    await aiComplete({
      task: "classify_reply",
      messages: [{ role: "user", content: `x${i}` }],
    }).catch(() => undefined);
  }
  await assert.rejects(
    () => aiComplete({ task: "classify_reply", messages: [{ role: "user", content: "y" }] }),
    (e: Error) => e instanceof AiUnavailableError || e instanceof AiBudgetExceededError,
  );
  const b = await budgetStatus();
  assert.ok(b.exceeded || b.paused);
});

test("15a · Grok rate limit fails over to Gemini automatically", async () => {
  await resetAll();
  mockStore().failGrok = "rate_limit";
  const res = await aiComplete({
    task: "classify_reply",
    messages: [{ role: "user", content: "sounds interesting" }],
  });
  assert.equal(res.provider, "gemini");
  assert.equal(res.failedOver, true);
  assert.ok(mockStore().aiCalls.every((c) => c.provider === "gemini"));

  // The failover and its reason are recorded in the usage ledger.
  const usage = await db.execute(
    sql`select provider, status, failover_reason from ai_usage order by id`,
  );
  const rows = usage.rows as { provider: string; status: string; failover_reason: string | null }[];
  assert.ok(rows.some((r) => r.provider === "grok" && r.status === "rate_limit"));
  const ok = rows.find((r) => r.provider === "gemini" && r.status === "ok");
  assert.ok(ok);
  assert.ok(ok!.failover_reason?.includes("grok"));
});

test("15b · exhausted Grok quota fails over; auth failure does not loop", async () => {
  await resetAll();
  mockStore().failGrok = "quota";
  const res = await aiComplete({ task: "score_lead", messages: [{ role: "user", content: "x" }] });
  assert.equal(res.provider, "gemini");

  // A permanent auth failure on both providers must not be retried forever.
  await resetAll();
  mockStore().failGrok = "auth";
  mockStore().failGemini = "auth";
  await assert.rejects(
    () => aiComplete({ task: "score_lead", messages: [{ role: "user", content: "x" }] }),
    AiUnavailableError,
  );
  const attempts = await db.execute(sql`select count(*)::int as n from ai_usage`);
  // One attempt per provider — no retry storm on a permanent failure.
  assert.equal((attempts.rows[0] as { n: number }).n, 2);
});

test("15c · failover respects Gemini's own budget — it is not assumed free", async () => {
  await resetAll();
  // Gemini has no remaining budget of its own.
  await updateSettings({ geminiDailyCapUsd: "0.0000" });
  mockStore().failGrok = "rate_limit";
  await assert.rejects(
    () => aiComplete({ task: "classify_reply", messages: [{ role: "user", content: "x" }] }),
    AiUnavailableError,
  );
  assert.equal(mockStore().aiCalls.length, 0);
  const blocked = await db.execute(
    sql`select count(*)::int as n from ai_usage where provider = 'gemini' and status = 'budget_blocked'`,
  );
  assert.equal((blocked.rows[0] as { n: number }).n, 1);

  // Failover can also be disabled outright.
  await resetAll();
  await updateSettings({ geminiEnabled: false });
  mockStore().failGrok = "rate_limit";
  await assert.rejects(
    () => aiComplete({ task: "classify_reply", messages: [{ role: "user", content: "x" }] }),
    AiUnavailableError,
  );
  assert.equal(mockStore().aiCalls.length, 0);
});

test("16 · a failed suppression lookup prevents sending", async () => {
  await resetAll();
  await seedProspect();
  await verifyProspects();
  await promoteEligible();
  await draftAndQueue();

  await db.execute(sql`alter table suppressions rename to suppressions_offline`);
  try {
    await assert.rejects(() => sendDueMessages(TEST_NOW));
    assert.equal(mockStore().sent.length, 0);
  } finally {
    await db.execute(sql`alter table suppressions_offline rename to suppressions`);
  }
});

test("17 · a restart does not lose scheduled jobs or suppression records", async () => {
  await resetAll();
  await enqueueJob({
    type: "generate_report",
    idempotencyKey: "durable-test-job",
    runAt: new Date(Date.now() - 1000),
  });
  await db.insert(suppressions).values({
    emailNormalized: "durable@outreach-test.example.com",
    reason: "unsubscribe",
  });

  // Simulate a process restart: nothing is held in memory, re-read from disk.
  const persistedJobs = await db.select().from(jobs);
  assert.equal(persistedJobs.length, 1);
  assert.equal(persistedJobs[0].status, "pending");
  assert.ok(await isSuppressed("durable@outreach-test.example.com"));

  const claimed = await claimNextJob();
  assert.equal(claimed?.idempotency_key, "durable-test-job");
  // The same recurring key cannot be double-enqueued.
  const again = await enqueueJob({ type: "generate_report", idempotencyKey: "durable-test-job" });
  assert.equal(again, null);
});

test("18 · the emergency stop blocks all new outbound messages", async () => {
  await resetAll();
  await seedProspect();
  await verifyProspects();
  await promoteEligible();
  await draftAndQueue();
  await updateSettings({ emergencyStop: true });

  assert.ok((await sendDueMessages(TEST_NOW)).startsWith("blocked:"));
  assert.ok((await draftAndQueue()).startsWith("skipped:"));
  assert.ok((await scheduleFollowups()).startsWith("skipped:"));
  assert.equal(mockStore().sent.length, 0);

  // Records are preserved, not deleted.
  const queuedMsgs = await db.select().from(emailMessages);
  assert.equal(queuedMsgs.length, 1);
  const [row] = await db.select().from(settingsTable);
  assert.equal(row.emergencyStop, true);
});

test("19 · credentials and private data do not appear in logs", async () => {
  const sample = redact({
    authorization: "Bearer ya29.a0AfH6SMBexampletokenvalue1234567890",
    client_secret: "GOCSPX-abcdefghijklmnop",
    note: "bot token 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw is secret",
    nested: { api_key: "xai-abcdefghijklmnopqrstuvwxyz" },
  }) as Record<string, unknown>;
  assert.equal(sample.authorization, "[REDACTED]");
  assert.equal(sample.client_secret, "[REDACTED]");
  assert.ok(!String(sample.note).includes("AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw"));
  assert.equal((sample.nested as Record<string, unknown>).api_key, "[REDACTED]");
});

test("20 · full end-to-end run using internal test addresses only", async () => {
  await resetAll();
  const { prospect } = await seedProspect({ fullName: "Anita Rao", role: "Wedding Planner", segment: "event_planner" });

  assert.ok((await verifyProspects()).includes("verified=1"));
  assert.ok((await promoteEligible()).includes("eligible=1"));
  assert.ok((await draftAndQueue()).includes("queued=1"));
  assert.ok((await sendDueMessages(TEST_NOW)).includes("sent=1"));

  const sent = mockStore().sent[0];
  assert.ok(sent.to.endsWith("outreach-test.example.com"));
  assert.ok(sent.body.includes("https://aurumbespoke.com"));
  assert.ok(sent.body.includes("+918040001234"));
  assert.ok(sent.body.includes("UNSUBSCRIBE"));
  assert.ok(sent.body.includes("Aurum Bespoke"));
  assert.ok(!/\{\{|\[name\]/i.test(sent.body));
  assert.ok(!/^(re|fwd):/i.test(sent.subject));

  pushInbound({
    id: "e2e-1",
    threadId: sent.threadId,
    from: `Anita Rao <${String(prospect.email)}>`,
    subject: `Re: ${sent.subject}`,
    body: "Interested — what is the lead time? You can reach me on my mobile 9845098450.",
  });
  await pollReplies();

  const [reply] = await db.select().from(replies);
  assert.ok(["interested", "pricing", "consultation", "ambiguous"].includes(reply.classification));
  const [p] = await db.select().from(prospects).where(eq(prospects.id, Number(prospect.id)));
  assert.ok(["INTERESTED", "AMBIGUOUS", "REPLIED"].includes(p.status));

  await updateSettings({ lastReportAt: new Date(Date.now() - 25 * 3600_000) });
  await generateReport();
  const delivered = await flushNotifications(30);
  assert.ok(delivered >= 9); // reply alert + approval-free summary + 7 PDFs
  const docs = mockStore().telegram.filter((t) => t.method === "sendDocument");
  assert.equal(docs.length, 7);
  assert.ok(docs.every((d) => d.documentName?.endsWith(".pdf")));
  // Every delivered document carries a unique 001-999 serial prefix.
  const serials = docs.map((d) => d.documentName!.slice(0, 3));
  assert.equal(new Set(serials).size, 7);
  assert.ok(serials.every((x) => /^\d{3}$/.test(x)));
  assert.ok(docs.some((d) => d.documentName?.includes("EVENT_PLANNERS")));
  assert.ok(docs.some((d) => d.documentName?.includes("MAIN_PROSPECTS")));
});

test("21 · deterministic stop rules are never delegated to AI", async () => {
  assert.equal(
    deterministicClassify({ fromEmail: "a@b.com", subject: "", body: "Please remove me from your list" }),
    "unsubscribe",
  );
  assert.equal(
    deterministicClassify({
      fromEmail: "mailer-daemon@googlemail.com",
      subject: "Delivery Status Notification (Failure)",
      body: "550 5.1.1 user unknown",
    }),
    "hard_bounce",
  );
  assert.equal(
    deterministicClassify({ fromEmail: "a@b.com", subject: "", body: "Not interested, thanks" }),
    "decline",
  );
  assert.equal(
    deterministicClassify({ fromEmail: "a@b.com", subject: "", body: "Sounds great, tell me more" }),
    null,
  );
});

/* ------------------------------------------------------------------ */
/* Adaptive sending controller                                         */
/* ------------------------------------------------------------------ */

test("22 · the adaptive controller raises volume only on measured evidence", async () => {
  await resetAll();
  const s = await getSettings();

  // No sending history yet -> hold, never a speculative increase.
  const cold = computeBudget(s, await collectHealthMetrics(), true);
  assert.equal(cold.action, "hold");
  assert.equal(cold.next, s.currentDailyBudget);
  assert.equal(cold.bindingConstraint, "insufficient_evidence");

  const clean = {
    windowDays: 14,
    sent: 40,
    hardBounces: 0,
    complaints: 0,
    optOuts: 0,
    declines: 1,
    positiveReplies: 5,
    bounceRate: 0,
    complaintRate: 0,
    optOutRate: 0,
    positiveRate: 0.125,
    avgVerificationConfidence: 85,
    eligiblePool: 30,
  };
  const grow = computeBudget(s, clean, true);
  assert.equal(grow.action, "increase");
  assert.ok(grow.next > grow.previous);

  // Growth is rate-limited to once per 24 hours.
  const tooSoon = computeBudget(s, clean, false);
  assert.equal(tooSoon.action, "hold");
  assert.equal(tooSoon.bindingConstraint, "growth_interval");

  // Poor recipient quality blocks growth even with clean delivery.
  const lowConfidence = computeBudget(s, { ...clean, avgVerificationConfidence: 40 }, true);
  assert.equal(lowConfidence.action, "hold");
  assert.equal(lowConfidence.bindingConstraint, "recipient_quality");
});

test("23 · deteriorating delivery health reduces or pauses sending", async () => {
  await resetAll();
  const s = await updateSettings({ currentDailyBudget: 20 });

  const halve = computeBudget(
    s,
    {
      windowDays: 14, sent: 100, hardBounces: 6, complaints: 0, optOuts: 0, declines: 0,
      positiveReplies: 1, bounceRate: 0.06, complaintRate: 0, optOutRate: 0,
      positiveRate: 0.01, avgVerificationConfidence: 80, eligiblePool: 10,
    },
    true,
  );
  assert.equal(halve.action, "decrease");
  assert.equal(halve.next, 10);

  const pause = computeBudget(
    s,
    {
      windowDays: 14, sent: 100, hardBounces: 12, complaints: 0, optOuts: 0, declines: 0,
      positiveReplies: 0, bounceRate: 0.12, complaintRate: 0, optOutRate: 0,
      positiveRate: 0, avgVerificationConfidence: 80, eligiblePool: 10,
    },
    true,
  );
  assert.equal(pause.action, "pause");
  assert.equal(pause.next, 0);

  const complaintPause = computeBudget(
    s,
    {
      windowDays: 14, sent: 100, hardBounces: 0, complaints: 2, optOuts: 0, declines: 0,
      positiveReplies: 0, bounceRate: 0, complaintRate: 0.02, optOutRate: 0,
      positiveRate: 0, avgVerificationConfidence: 80, eligiblePool: 10,
    },
    true,
  );
  assert.equal(complaintPause.action, "pause");
});

test("24 · the controller never exceeds the strictest configured limit", async () => {
  await resetAll();
  // Operator-verified provider limit is stricter than the ceiling.
  const s = await updateSettings({
    currentDailyBudget: 8,
    budgetCeiling: 40,
    providerDailyLimit: 10,
    budgetGrowthPct: 100,
  });
  const clean = {
    windowDays: 14, sent: 50, hardBounces: 0, complaints: 0, optOuts: 0, declines: 0,
    positiveReplies: 6, bounceRate: 0, complaintRate: 0, optOutRate: 0,
    positiveRate: 0.12, avgVerificationConfidence: 90, eligiblePool: 50,
  };
  const d = computeBudget(s, clean, true);
  // +100% would be 16, but the provider limit of 10 binds.
  assert.equal(d.next, 10);

  const atLimit = computeBudget({ ...s, currentDailyBudget: 10 }, clean, true);
  assert.equal(atLimit.action, "hold");
  assert.equal(atLimit.bindingConstraint, "provider_limit");
});

test("25 · the adaptive budget is persisted and audited, and caps real sends", async () => {
  await resetAll();
  await updateSettings({ currentDailyBudget: 2 });
  for (let i = 0; i < 4; i++) await seedProspect();

  await verifyProspects();
  await promoteEligible();
  const queued = await draftAndQueue();
  assert.ok(queued.includes("capacity=2"), queued);
  await sendDueMessages(TEST_NOW);
  assert.equal(mockStore().sent.length, 2);

  // A second pass cannot exceed the budget.
  await draftAndQueue();
  await sendDueMessages(TEST_NOW);
  assert.equal(mockStore().sent.length, 2);

  const decision = await evaluateDailyBudget(true);
  assert.ok(decision);
  const persisted = await db.execute(sql`select count(*)::int as n from budget_decisions`);
  assert.equal((persisted.rows[0] as { n: number }).n, 1);
});

/* ------------------------------------------------------------------ */
/* Luxury copy quality                                                 */
/* ------------------------------------------------------------------ */

test("26 · generic, hyped or flattering drafts are rejected", async () => {
  const evidence = [
    {
      id: 1,
      claimText: "Rohan Mehta is Managing Director at Mehta Advisory LLP",
      sourceUrl: "https://example.com/x",
      excerpt: "Rohan Mehta is Managing Director at Mehta Advisory LLP in Bengaluru.",
      verified: true,
      retrievedAt: new Date(),
    },
  ];
  const bad = deterministicQuality({
    subject: "An AMAZING opportunity you cannot miss!",
    body:
      "Dear Rohan,\n\nI hope this email finds you well. I just wanted to reach out, Rohan, because I am a huge fan of your incredible work. " +
      "Rohan, this is an amazing, game-changing opportunity. Limited slots available, act now! " +
      "Can we talk? Are you free? What do you think? Shall I call?\n\nUNSUBSCRIBE to opt out.",
    recipientFirstName: "Rohan",
    hook: null,
    evidence,
    isFollowup: false,
  });
  assert.ok(bad.score < 50, `expected a low score, got ${bad.score}`);
  const codes = bad.issues.map((i) => i.code);
  assert.ok(codes.includes("HYPE_LANGUAGE"));
  assert.ok(codes.includes("EXCESSIVE_FLATTERY"));
  assert.ok(codes.includes("MANUFACTURED_URGENCY"));
  assert.ok(codes.includes("BULK_TEMPLATE_PHRASING"));
  assert.ok(codes.includes("NAME_REPETITION"));
  assert.ok(codes.includes("TOO_MANY_QUESTIONS"));

  const good = deterministicQuality({
    subject: "Made-to-measure tailoring in Bengaluru",
    body:
      "Dear Rohan,\n\nI came across your work as Managing Director at Mehta Advisory LLP. Your work there is the kind of " +
      "client-facing role where well-cut formalwear tends to earn its keep.\n\nAurum Bespoke is a bespoke tailoring house in " +
      "Bengaluru. We make made-to-measure suits, jackets and shirts, cut to individual measurements, with fittings arranged " +
      "around your schedule.\n\nIf that is of interest, I would be glad to arrange a fitting appointment at your convenience.\n\n" +
      'If you would prefer no further emails, reply with "UNSUBSCRIBE" and I will remove you immediately.\n\n' +
      "With regards,\nAurum Bespoke\nhttps://aurumbespoke.com\nPhone: +918040001234",
    recipientFirstName: "Rohan",
    hook: "Managing Director at Mehta Advisory LLP",
    evidence,
    isFollowup: false,
  });
  assert.ok(good.score >= 75, `expected a passing score, got ${good.score}: ${JSON.stringify(good.issues)}`);
});

test("27 · a draft below the quality threshold is never sent", async () => {
  await resetAll();
  await seedProspect();
  await verifyProspects();
  await promoteEligible();
  // An unreachable threshold must block the send rather than force it.
  await updateSettings({ minQualityScore: 100 });
  const out = await draftAndQueue();
  assert.ok(out.includes("blocked=1"), out);
  await sendDueMessages(TEST_NOW);
  assert.equal(mockStore().sent.length, 0);

  const [msg] = await db.select().from(emailMessages);
  assert.equal(msg.status, "blocked");
  assert.ok(msg.blockedReason?.includes("QUALITY"));
  const [p] = await db.select().from(prospects);
  assert.equal(p.status, "REVIEW");
});

test("28 · low-relevance leads are scored out before outreach", async () => {
  const weak = scoreLead({
    role: null, company: null, city: "Bengaluru", segment: "professional", website: null,
    emailStatus: "unverified", emailSourceUrl: null, bengaluruEvidenceUrl: null,
    claimCount: 0, verifiedClaimCount: 0,
  });
  assert.ok(weak.score < 60);

  const strong = scoreLead({
    role: "Managing Director", company: "Mehta Advisory LLP", city: "Bengaluru",
    segment: "professional", website: "https://example.com", emailStatus: "source_verified",
    emailSourceUrl: "https://example.com/team", bengaluruEvidenceUrl: "https://example.com/team",
    claimCount: 1, verifiedClaimCount: 1,
  });
  assert.ok(strong.score >= 60);
  assert.ok(strong.confidence >= 70);

  await resetAll();
  await seedProspect();
  await db.update(prospects).set({ leadScore: 10 });
  await verifyProspects();
  await promoteEligible();
  const [p] = await db.select().from(prospects);
  assert.equal(p.status, "REVIEW");
  assert.ok(p.reviewReason?.includes("Lead score"));
});

/* ------------------------------------------------------------------ */
/* Appointments and human approval                                     */
/* ------------------------------------------------------------------ */

test("29 · a meeting is never marked confirmed without explicit evidence", async () => {
  assert.equal(detectAppointment("Could we schedule a fitting next week?")?.status, "awaiting_confirmation");
  assert.equal(detectAppointment("Thursday 4pm works for me for the fitting.")?.status, "confirmed");
  assert.equal(detectAppointment("Can we reschedule the meeting?")?.status, "rescheduled");
  assert.equal(detectAppointment("I need to cancel our appointment.")?.status, "cancelled");
  assert.equal(detectAppointment("Thanks for the note."), null);

  await resetAll();
  const { prospect } = await seedProspect();
  await runToSend();
  const sent = mockStore().sent[0];
  pushInbound({
    id: "appt-1",
    threadId: sent.threadId,
    from: String(prospect.email),
    subject: "Re: outreach",
    body: "Interested — could we arrange a consultation sometime next week?",
  });
  await pollReplies();

  const [appt] = await db.select().from(appointments);
  assert.ok(appt);
  assert.equal(appt.status, "awaiting_confirmation");
  assert.equal(appt.scheduledFor, null); // no date was supplied, none invented
  assert.ok(appt.evidenceExcerpt);
});

test("30 · substantive sales replies require human approval and are never auto-answered", async () => {
  await resetAll();
  const { prospect } = await seedProspect();
  await runToSend();
  const sentCountBefore = mockStore().sent.length;
  const sent = mockStore().sent[0];

  pushInbound({
    id: "approve-1",
    threadId: sent.threadId,
    from: String(prospect.email),
    subject: "Re: outreach",
    body: "Interested. What would a two-piece suit cost?",
  });
  await pollReplies();

  const [approval] = await db.select().from(approvals);
  assert.ok(approval);
  assert.equal(approval.status, "pending");
  assert.ok(approval.kind.startsWith("respond_"));

  // No automated sales reply was sent.
  assert.equal(mockStore().sent.length, sentCountBefore);
  await sendDueMessages(TEST_NOW);
  assert.equal(mockStore().sent.length, sentCountBefore);
});

test("31 · preflight blocks launch when critical configuration is missing", async () => {
  await resetAll();
  await updateSettings({ businessPhone: null, businessPhoneVerified: false });
  const blocked = await runPreflight();
  assert.equal(blocked.canLaunch, false);
  assert.ok(blocked.failedCritical.some((f) => /phone/i.test(f)));

  await updateSettings({ businessPhone: "+918040001234", businessPhoneVerified: true });
  const passed = await runPreflight();
  assert.equal(passed.canLaunch, true, JSON.stringify(passed.failedCritical));
  // Mock-mode gaps are surfaced as warnings, never silently passed.
  assert.ok(passed.checks.some((c) => c.status === "warn"));
  assert.ok(passed.checks.some((c) => c.id === "pdf" && c.status === "pass"));
  assert.ok(passed.checks.some((c) => c.id === "serial" && c.status === "pass"));
});
