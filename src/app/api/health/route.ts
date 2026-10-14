import { db } from "@/db";
import { sql } from "drizzle-orm";
import { getSettings, evaluateSendGate } from "@/lib/settings";
import { gmailHealth } from "@/lib/providers/gmail";
import { providerHealth, budgetStatus } from "@/lib/providers/ai";
import { deadLetterCount, pendingJobCount } from "@/lib/jobs/queue";
import { env, integrationStatus, missingEnvForSending } from "@/lib/env";
import { errorMessage } from "@/lib/log";

export const dynamic = "force-dynamic";

export async function GET() {
  const checks: Record<string, { ok: boolean; detail: string }> = {};

  try {
    await db.execute(sql`select 1`);
    checks.database = { ok: true, detail: "connected" };
  } catch (e) {
    checks.database = { ok: false, detail: errorMessage(e) };
    return Response.json({ ok: false, checks }, { status: 500 });
  }

  let gateReasons: string[] = [];
  try {
    const s = await getSettings();
    const gate = evaluateSendGate(s);
    gateReasons = gate.reasons;
    checks.sendGate = {
      ok: gate.allowed,
      detail: gate.allowed ? "live sending permitted" : gate.reasons.join("; "),
    };
    checks.scheduler = {
      ok: true,
      detail: env.schedulerEnabled ? "in-process loop enabled" : "external cron mode",
    };
    checks.reporting = {
      ok: true,
      detail: s.lastReportAt
        ? `last report ${s.lastReportAt.toISOString()}`
        : "no report generated yet",
    };
  } catch (e) {
    checks.settings = { ok: false, detail: errorMessage(e) };
  }

  try {
    checks.gmail = await gmailHealth();
  } catch (e) {
    checks.gmail = { ok: false, detail: errorMessage(e) };
  }

  try {
    const [grok, gemini] = await Promise.all([
      providerHealth("grok"),
      providerHealth("gemini"),
    ]);
    checks.aiPrimary = grok;
    checks.aiFailover = gemini;
    // AI is "ok" when at least one provider can serve work.
    checks.ai = {
      ok: grok.ok || gemini.ok,
      detail: `grok=${grok.ok ? "ok" : "down"} gemini=${gemini.ok ? "ok" : "down"}`,
    };
    const b = await budgetStatus();
    checks.aiBudget = {
      ok: !b.exceeded && !b.paused,
      detail: `daily $${b.daily.toFixed(4)}/$${b.dailyCap} · monthly $${b.monthly.toFixed(4)}/$${b.monthlyCap}${b.paused ? " · PAUSED" : ""}`,
    };
  } catch (e) {
    checks.ai = { ok: false, detail: errorMessage(e) };
  }

  const integrations = integrationStatus();
  checks.telegram = {
    ok: integrations.telegram || integrations.mockMode,
    detail: integrations.mockMode
      ? "mock mode"
      : integrations.telegram
        ? "configured"
        : "TELEGRAM_BOT_TOKEN/CHAT_ID missing",
  };

  try {
    const [pending, dead] = await Promise.all([pendingJobCount(), deadLetterCount()]);
    checks.jobs = { ok: dead === 0, detail: `pending=${pending} dead=${dead}` };
  } catch (e) {
    checks.jobs = { ok: false, detail: errorMessage(e) };
  }

  // The health endpoint stays 200 while the database is reachable: a missing
  // integration pauses outbound email, it does not take the service down.
  return Response.json({
    ok: true,
    sendingPermitted: gateReasons.length === 0,
    blockers: [...gateReasons, ...missingEnvForSending().map((g) => `${g.key}: ${g.detail}`)],
    integrations,
    checks,
  });
}
