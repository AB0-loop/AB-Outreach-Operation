import { db } from "@/db";
import { sql } from "drizzle-orm";
import { env, integrationStatus } from "./env";
import { getSettings, evaluateSendGate, isValidIndianBusinessPhone } from "./settings";
import { gmailHealth, getAccount } from "./providers/gmail";
import { providerHealth, budgetStatus } from "./providers/ai";
import { deadLetterCount, pendingJobCount } from "./jobs/queue";
import { peekSerial } from "./serial";
import { ReportBuilder } from "./pdf";
import { enqueueNotification, flushNotifications } from "./providers/telegram";
import { errorMessage } from "./log";

export type CheckStatus = "pass" | "warn" | "fail";
export type Check = {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
  /** A failing critical check blocks Launch. */
  critical: boolean;
  fix?: string;
};

export type PreflightResult = {
  ok: boolean;
  canLaunch: boolean;
  checks: Check[];
  failedCritical: string[];
  ranAt: string;
};

const ok = (id: string, label: string, detail: string, critical = true): Check => ({
  id, label, status: "pass", detail, critical,
});
const fail = (id: string, label: string, detail: string, fix: string, critical = true): Check => ({
  id, label, status: "fail", detail, critical, fix,
});
const warn = (id: string, label: string, detail: string, fix?: string): Check => ({
  id, label, status: "warn", detail, critical: false, fix,
});

/**
 * Verifies that each dependency actually works. The presence of an API key is
 * never treated as evidence that a service is usable.
 */
export async function runPreflight(): Promise<PreflightResult> {
  const checks: Check[] = [];
  const integrations = integrationStatus();

  /* 1. Database + migrations */
  try {
    await db.execute(sql`select 1`);
    const tables = await db.execute(sql`
      select table_name from information_schema.tables
      where table_schema = 'public'
    `);
    const names = new Set((tables.rows as { table_name: string }[]).map((r) => r.table_name));
    const required = [
      "prospects", "evidence_claims", "email_messages", "replies", "suppressions",
      "jobs", "notifications", "reports", "report_counter", "appointments",
      "budget_decisions", "approvals", "settings", "audit_log", "oauth_accounts",
      "processed_events", "state_transitions", "ai_usage",
    ];
    const missing = required.filter((t) => !names.has(t));
    checks.push(
      missing.length === 0
        ? ok("db", "Database connectivity and migrations", `${required.length} tables present`)
        : fail("db", "Database connectivity and migrations", `Missing tables: ${missing.join(", ")}`, "Run `npx drizzle-kit push`"),
    );
  } catch (e) {
    checks.push(fail("db", "Database connectivity and migrations", errorMessage(e), "Check DATABASE_URL and that PostgreSQL is reachable"));
    return finalise(checks);
  }

  const s = await getSettings();

  /* 2. Secure production configuration */
  const insecure: string[] = [];
  if (!env.adminPassword) insecure.push("ADMIN_PASSWORD is not set");
  else if (env.adminPassword.length < 12) insecure.push("ADMIN_PASSWORD is shorter than 12 characters");
  if (env.sessionSecret.startsWith("dev-only")) insecure.push("SESSION_SECRET is still the development default");
  if (!env.encryptionKey) insecure.push("TOKEN_ENCRYPTION_KEY is not set");
  else if (/^0+$/.test(env.encryptionKey)) insecure.push("TOKEN_ENCRYPTION_KEY is a placeholder value");
  if (!env.mockMode && !env.appUrl.startsWith("https://")) insecure.push("APP_BASE_URL is not HTTPS");
  checks.push(
    insecure.length === 0
      ? ok("security", "Secure production configuration", "Secrets present and non-default")
      : env.mockMode
        ? // Mock mode cannot send real email, so dev secrets only warn. They
          // become hard blockers the moment OUTREACH_MOCK=0.
          warn("security", "Secure production configuration", `${insecure.join("; ")} (mock mode — blocking in production)`, "Set strong values before setting OUTREACH_MOCK=0")
        : fail("security", "Secure production configuration", insecure.join("; "), "Set strong values in .env (see docs/ACTIVATION.md)"),
  );

  /* 3. Brand and business contact information */
  const phoneOk = Boolean(s.businessPhone && s.businessPhoneVerified && isValidIndianBusinessPhone(s.businessPhone));
  checks.push(
    phoneOk
      ? ok("brand", "Business phone and brand details", `${s.businessPhone} · ${s.businessWebsite}`)
      : fail("brand", "Business phone and brand details", "Verified business phone is not configured", "Dashboard → enter the real number → Save & mark verified"),
  );
  checks.push(
    s.senderEmail.includes("@") && s.businessWebsite.startsWith("https://")
      ? ok("brand_links", "Sender identity and website", `${s.senderEmail} · ${s.businessWebsite}`)
      : fail("brand_links", "Sender identity and website", "Sender email or website is not configured", "Set them in settings"),
  );

  /* 4. Gmail authorisation, sending capability, reply monitoring */
  if (env.mockMode) {
    checks.push(warn("gmail", "Gmail authorisation", "Mock mode — no real Gmail account is connected", "Set OUTREACH_MOCK=0 and connect Gmail for production"));
  } else {
    const health = await gmailHealth();
    const acct = await getAccount();
    checks.push(
      health.ok
        ? ok("gmail", "Gmail authorisation", health.detail)
        : fail("gmail", "Gmail authorisation", health.detail, "Dashboard → Connect Gmail (see docs/SETUP_GMAIL.md)"),
    );
    checks.push(
      acct?.scopes?.includes("gmail.send") && acct?.scopes?.includes("gmail.readonly")
        ? ok("gmail_scopes", "Gmail permissions (send + read)", acct.scopes)
        : fail("gmail_scopes", "Gmail permissions (send + read)", acct?.scopes ?? "no scopes recorded", "Re-authorise and grant both scopes"),
    );
    checks.push(
      acct && acct.email.toLowerCase() === s.senderEmail.toLowerCase()
        ? ok("gmail_identity", "Authorised account matches configured sender", acct.email)
        : fail("gmail_identity", "Authorised account matches configured sender", `authorised=${acct?.email ?? "none"} configured=${s.senderEmail}`, "Authorise the correct mailbox or change the sender setting"),
    );
    checks.push(
      env.gmailPubsubTopic && env.gmailPushSecret
        ? ok("reply_monitor", "Reply monitoring", "Gmail push configured; polling retained as reconciliation", false)
        : warn("reply_monitor", "Reply monitoring", "Polling only (every 2 minutes) — acceptable, push is optional", "Set GMAIL_PUBSUB_TOPIC + GMAIL_PUSH_SECRET for lower latency"),
    );
    checks.push(
      warn("live_send_test", "Live test send", "Not performed automatically — a real email must never be sent without an explicit operator action", "Dashboard → Send test email to your own address"),
    );
  }

  /* 5. AI providers */
  const grok = await providerHealth("grok");
  checks.push(
    grok.ok
      ? ok("ai_grok", "Grok (primary AI)", grok.detail, false)
      : warn("ai_grok", "Grok (primary AI)", grok.detail, "Set XAI_API_KEY and confirm billing (docs/SETUP_AI.md)"),
  );
  if (s.geminiEnabled) {
    const gem = await providerHealth("gemini");
    checks.push(
      gem.ok
        ? ok("ai_gemini", "Gemini (failover AI)", gem.detail, false)
        : warn("ai_gemini", "Gemini (failover AI)", gem.detail, "Set GEMINI_API_KEY, or disable failover in settings"),
    );
  } else {
    checks.push(warn("ai_gemini", "Gemini (failover AI)", "Failover disabled by configuration"));
  }
  const budget = await budgetStatus();
  checks.push(
    !budget.paused && !budget.exceeded
      ? ok("ai_budget", "AI spending ceilings", `daily $${budget.daily.toFixed(4)}/$${budget.dailyCap} · grok cap $${budget.grokDailyCap} · gemini cap $${budget.geminiDailyCap}`, false)
      : warn("ai_budget", "AI spending ceilings", budget.pausedReason ?? "ceiling reached", "Raise the cap or top up, then Resume AI"),
  );

  /* 6. Telegram */
  if (env.mockMode) {
    checks.push(warn("telegram", "Telegram delivery", "Mock mode — notifications are captured in memory"));
  } else if (!integrations.telegram) {
    checks.push(fail("telegram", "Telegram delivery", "TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not configured", "See docs/SETUP_TELEGRAM.md"));
  } else {
    await enqueueNotification({
      kind: "system",
      dedupeKey: `preflight-${Date.now()}`,
      text: "✅ <b>Preflight</b> — Telegram delivery verified.",
    });
    const delivered = await flushNotifications(3);
    checks.push(
      delivered > 0
        ? ok("telegram", "Telegram delivery", "Test notification delivered")
        : fail("telegram", "Telegram delivery", "Test notification was not delivered", "Check the bot token, chat id and that the bot is not blocked"),
    );
    checks.push(
      env.telegramWebhookSecret
        ? ok("telegram_actions", "Telegram action handling", "Webhook secret configured", false)
        : warn("telegram_actions", "Telegram action handling", "TELEGRAM_WEBHOOK_SECRET not set — control buttons will not work", "Run setWebhook with a secret_token"),
    );
  }

  /* 7. PDF generation + durable serial numbering */
  try {
    const counter = await peekSerial();
    const b = new ReportBuilder({
      serial: "000",
      title: "Preflight PDF Self-Test",
      periodStart: new Date(),
      periodEnd: new Date(),
      generatedAt: new Date(),
      timezone: s.timezone,
    });
    b.heading("Self test");
    b.table([{ key: "a", label: "Check", width: 100 }], [{ a: "pdf engine" }]);
    const pdf = await b.finish();
    checks.push(
      pdf.length > 800 && pdf.subarray(0, 4).toString("latin1") === "%PDF"
        ? ok("pdf", "PDF generation", `${pdf.length} byte test document rendered`)
        : fail("pdf", "PDF generation", "Generated file is not a valid PDF", "Check the pdfkit dependency"),
    );
    checks.push(
      ok("serial", "Durable report serial numbering", `next serial ${String((counter.lastSerial % 999) + 1).padStart(3, "0")} · cycle ${counter.cycle}`),
    );
  } catch (e) {
    checks.push(fail("pdf", "PDF generation", errorMessage(e), "Check the pdfkit dependency"));
  }

  /* 8. Scheduler and background workers */
  try {
    const [pending, dead] = await Promise.all([pendingJobCount(), deadLetterCount()]);
    checks.push(
      ok("scheduler", "Scheduled jobs and background worker",
        `${env.schedulerEnabled ? "in-process scheduler enabled" : "external cron mode"} · pending=${pending} dead=${dead}`),
    );
    checks.push(
      dead === 0
        ? ok("deadletter", "Dead-letter queue", "empty", false)
        : warn("deadletter", "Dead-letter queue", `${dead} job(s) permanently failed`, "Inspect jobs.last_error on the dashboard"),
    );
    if (!env.schedulerEnabled && !env.cronSecret)
      checks.push(
        env.mockMode
          ? warn("cron", "External scheduler secret", "SCHEDULER_ENABLED=0 and no CRON_SECRET (mock mode)", "Set CRON_SECRET before production")
          : fail("cron", "External scheduler secret", "SCHEDULER_ENABLED=0 but CRON_SECRET is not set", "Set CRON_SECRET or re-enable the in-process scheduler"),
      );
  } catch (e) {
    checks.push(fail("scheduler", "Scheduled jobs and background worker", errorMessage(e), "Inspect the jobs table"));
  }

  /* 9. Safety controls */
  const gate = evaluateSendGate({ ...s, emergencyStop: false, sendingEnabled: true });
  checks.push(
    gate.allowed
      ? ok("send_gate", "Suppression, duplicate and content gates", "All content and safety gates satisfied")
      : fail("send_gate", "Suppression, duplicate and content gates", gate.reasons.join("; "), "Resolve each blocker listed on the dashboard"),
  );
  checks.push(ok("emergency_stop", "Emergency stop", s.emergencyStop ? "ACTIVE (safe default)" : "available", false));

  /* 10. Backup */
  checks.push(
    warn("backup", "Backup and recovery", "Cannot be verified from inside the application", "Confirm the pg_dump cron and restore drill in docs/DEPLOYMENT.md"),
  );

  return finalise(checks);
}

function finalise(checks: Check[]): PreflightResult {
  const failedCritical = checks.filter((c) => c.critical && c.status === "fail").map((c) => c.label);
  return {
    ok: checks.every((c) => c.status !== "fail"),
    canLaunch: failedCritical.length === 0,
    checks,
    failedCritical,
    ranAt: new Date().toISOString(),
  };
}
