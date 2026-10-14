import { guard, currentUser } from "@/lib/auth";
import { getSettings, updateSettings, evaluateSendGate, isValidIndianBusinessPhone, normalizePhone } from "@/lib/settings";
import { ingestProspects, type ProspectInput } from "@/lib/discovery";
import { enqueueReportNow } from "@/lib/jobs/handlers";
import { runPreflight } from "@/lib/preflight";
import { evaluateDailyBudget } from "@/lib/budget";
import { sendEmail } from "@/lib/providers/gmail";
import { renderBody } from "@/lib/compose";
import { tick } from "@/lib/jobs/runner";
import { suppress } from "@/lib/suppression";
import { enqueueNotification } from "@/lib/providers/telegram";
import { controlKeyboard } from "@/lib/notify";
import { audit } from "@/lib/audit";
import { errorMessage } from "@/lib/log";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: Request) {
  const unauthorized = await guard();
  if (unauthorized) return unauthorized;
  const user = (await currentUser()) ?? "operator";

  let body: { action?: string; payload?: Record<string, unknown> };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const action = body.action;
  const payload = body.payload ?? {};

  try {
    switch (action) {
      case "emergency_stop": {
        const s = await updateSettings({ emergencyStop: true, sendingEnabled: false });
        await audit({ actor: user, action: "emergency_stop.on" });
        await enqueueNotification({
          kind: "system",
          dedupeKey: `sys-stop-${Date.now()}`,
          text: "🛑 <b>EMERGENCY STOP ACTIVE</b>\nActivated from the dashboard. All new outbound email is blocked.",
          replyMarkup: controlKeyboard(s),
        });
        return Response.json({ ok: true, settings: s });
      }
      case "clear_emergency_stop": {
        const s = await updateSettings({ emergencyStop: false });
        await audit({ actor: user, action: "emergency_stop.off" });
        return Response.json({ ok: true, settings: s });
      }
      case "set_sending": {
        const enabled = Boolean(payload.enabled);
        if (enabled) {
          const current = await getSettings();
          const gate = evaluateSendGate({ ...current, sendingEnabled: true, emergencyStop: false });
          if (!gate.allowed) return Response.json({ error: gate.reasons.join("; ") }, { status: 400 });
        }
        const s = await updateSettings({ sendingEnabled: enabled, ...(enabled ? { emergencyStop: false } : {}) });
        await audit({ actor: user, action: enabled ? "sending.enable" : "sending.pause" });
        return Response.json({ ok: true, settings: s });
      }
      case "set_business_phone": {
        const raw = String(payload.phone ?? "");
        const phone = normalizePhone(raw);
        if (!isValidIndianBusinessPhone(phone))
          return Response.json(
            { error: "Phone must be a valid Indian number in +91XXXXXXXXXX form" },
            { status: 400 },
          );
        const s = await updateSettings({
          businessPhone: phone,
          businessPhoneVerified: Boolean(payload.verified),
        });
        await audit({ actor: user, action: "settings.business_phone", detail: { verified: Boolean(payload.verified) } });
        return Response.json({ ok: true, settings: s });
      }
      case "update_settings": {
        const allowed = [
          "dailyCap",
          "followupBusinessDays",
          "sendWindowStartHour",
          "sendWindowEndHour",
          "professionalRatio",
          "aiModel",
          "aiDailyCapUsd",
          "aiMonthlyCapUsd",
          "businessAddress",
          "senderEmail",
        ] as const;
        const patch: Record<string, unknown> = {};
        for (const k of allowed) if (payload[k] !== undefined) patch[k] = payload[k];
        if (typeof patch.dailyCap === "number" && patch.dailyCap > 20)
          return Response.json({ error: "Daily cap above 20 is not permitted" }, { status: 400 });
        const s = await updateSettings(patch);
        await audit({ actor: user, action: "settings.update", detail: patch });
        return Response.json({ ok: true, settings: s });
      }
      case "resume_ai": {
        const s = await updateSettings({ aiPaused: false, aiPausedReason: null });
        await audit({ actor: user, action: "ai.resume" });
        return Response.json({ ok: true, settings: s });
      }
      case "import_prospects": {
        const records = (payload.records ?? []) as ProspectInput[];
        if (!Array.isArray(records) || records.length === 0)
          return Response.json({ error: "No records supplied" }, { status: 400 });
        if (records.length > 200)
          return Response.json({ error: "Maximum 200 records per import" }, { status: 400 });
        const result = await ingestProspects(records, user);
        return Response.json({ ok: true, result });
      }
      case "suppress_email": {
        const email = String(payload.email ?? "");
        if (!email.includes("@")) return Response.json({ error: "Invalid email" }, { status: 400 });
        await suppress({ email, reason: "manual", sourceRef: `dashboard:${user}` });
        await audit({ actor: user, action: "suppression.add", detail: { email } });
        return Response.json({ ok: true });
      }
      case "preflight": {
        const result = await runPreflight();
        await updateSettings({
          preflightPassedAt: result.canLaunch ? new Date() : null,
        });
        await audit({ actor: user, action: "preflight.run", detail: { canLaunch: result.canLaunch } });
        return Response.json({ ok: true, result });
      }
      case "launch": {
        // Launch always re-runs preflight; a stale pass can never authorise it.
        const result = await runPreflight();
        if (!result.canLaunch) {
          await updateSettings({ preflightPassedAt: null });
          return Response.json(
            { error: `Preflight failed: ${result.failedCritical.join("; ")}`, result },
            { status: 400 },
          );
        }
        const s = await updateSettings({
          preflightPassedAt: new Date(),
          launchedAt: new Date(),
          emergencyStop: false,
          sendingEnabled: true,
        });
        await evaluateDailyBudget(true);
        await audit({ actor: user, action: "system.launch" });
        await enqueueNotification({
          kind: "system",
          dedupeKey: `launch-${Date.now()}`,
          text: `🚀 <b>Aurum Bespoke outreach launched</b>\nPreflight passed. Adaptive daily budget: ${s.currentDailyBudget}.`,
          replyMarkup: controlKeyboard(s),
        });
        return Response.json({ ok: true, result, settings: s });
      }
      case "send_test_email": {
        const to = String(payload.to ?? "");
        if (!to.includes("@")) return Response.json({ error: "A test recipient address is required" }, { status: 400 });
        const cur = await getSettings();
        const gate = evaluateSendGate({ ...cur, emergencyStop: false, sendingEnabled: true });
        if (!gate.allowed) return Response.json({ error: gate.reasons.join("; ") }, { status: 400 });
        const body = renderBody({
          settings: cur,
          prospect: {
            fullName: "Test Recipient",
            role: "Operator",
            company: "Aurum Bespoke",
            segment: "professional",
          } as Parameters<typeof renderBody>[0]["prospect"],
          openingSentence: null,
          isFollowup: false,
        });
        const res = await sendEmail({
          from: cur.senderEmail,
          fromName: cur.senderName,
          to,
          subject: "Aurum Bespoke — outreach system test",
          body: `This is a configuration test from the Aurum Bespoke outreach system.\n\n${body}`,
        });
        await audit({ actor: user, action: "test_email.sent", detail: { to, ...res } });
        return Response.json({ ok: true, result: res });
      }
      case "recompute_budget": {
        const d = await evaluateDailyBudget(true);
        await audit({ actor: user, action: "budget.manual_recompute" });
        return Response.json({ ok: true, result: d });
      }
      case "report_now": {
        await enqueueReportNow();
        await audit({ actor: user, action: "report.manual" });
        return Response.json({ ok: true });
      }
      case "run_tick": {
        const result = await tick();
        return Response.json({ ok: true, result });
      }
      default:
        return Response.json({ error: "unknown action" }, { status: 400 });
    }
  } catch (e) {
    return Response.json({ error: errorMessage(e) }, { status: 500 });
  }
}
