import { db } from "@/db";
import { processedEvents, replies, prospects } from "@/db/schema";
import { eq } from "drizzle-orm";
import { env } from "@/lib/env";
import { timingSafeEqual } from "@/lib/crypto";
import { getSettings, updateSettings } from "@/lib/settings";
import { answerCallbackQuery, enqueueNotification, flushNotifications } from "@/lib/providers/telegram";
import { controlKeyboard, statusText } from "@/lib/notify";
import { counts, enqueueReportNow } from "@/lib/jobs/handlers";
import { deadLetterCount, pendingJobCount } from "@/lib/jobs/queue";
import { budgetStatus } from "@/lib/providers/ai";
import { evaluateSendGate } from "@/lib/settings";
import { suppress } from "@/lib/suppression";
import { transition } from "@/lib/state";
import { audit } from "@/lib/audit";
import { errorMessage, log } from "@/lib/log";

export const dynamic = "force-dynamic";

type CallbackQuery = {
  id: string;
  data?: string;
  from?: { id: number };
  message?: { chat?: { id: number }; message_id?: number };
};

type Update = { update_id: number; callback_query?: CallbackQuery };

export async function POST(req: Request) {
  const secret = env.telegramWebhookSecret;
  const header = req.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (!secret || !header || !timingSafeEqual(header, secret)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let update: Update;
  try {
    update = (await req.json()) as Update;
  } catch {
    return Response.json({ ok: true });
  }

  const inserted = await db
    .insert(processedEvents)
    .values({ source: "telegram_update", eventId: String(update.update_id) })
    .onConflictDoNothing()
    .returning({ id: processedEvents.id });
  if (!inserted[0]) return Response.json({ ok: true, duplicate: true });

  const cq = update.callback_query;
  if (!cq?.data) return Response.json({ ok: true });

  // Only the configured operator chat may control the system.
  const chatId = String(cq.message?.chat?.id ?? "");
  if (env.telegramChatId && chatId && chatId !== env.telegramChatId) {
    await answerCallbackQuery(cq.id, "Unauthorized chat.");
    return Response.json({ ok: true });
  }

  try {
    const feedback = await handleAction(cq.data);
    await answerCallbackQuery(cq.id, feedback);
    await flushNotifications(5);
  } catch (e) {
    log.error("telegram_action_failed", { error: errorMessage(e) });
    await answerCallbackQuery(cq.id, "Action failed. Check the dashboard.");
  }
  return Response.json({ ok: true });
}

async function handleAction(data: string): Promise<string> {
  const [scope, action, arg] = data.split(":");

  if (scope === "ctl") {
    if (action === "stop") {
      const s = await updateSettings({ emergencyStop: true, sendingEnabled: false });
      await audit({ actor: "telegram", action: "emergency_stop.on" });
      await enqueueNotification({
        kind: "system",
        dedupeKey: `sys-stop-${Date.now()}`,
        text: "🛑 <b>EMERGENCY STOP ACTIVE</b>\nAll new outbound email and follow-ups are blocked. Records are preserved.",
        replyMarkup: controlKeyboard(s),
      });
      return "Emergency stop activated";
    }
    if (action === "resume") {
      const s = await updateSettings({ emergencyStop: false });
      await audit({ actor: "telegram", action: "emergency_stop.off" });
      await enqueueNotification({
        kind: "system",
        dedupeKey: `sys-resume-${Date.now()}`,
        text: "✅ <b>Emergency stop cleared</b>\nSending remains paused until explicitly enabled.",
        replyMarkup: controlKeyboard(s),
      });
      return "Emergency stop cleared";
    }
    if (action === "pause") {
      const s = await updateSettings({ sendingEnabled: false });
      await audit({ actor: "telegram", action: "sending.pause" });
      await enqueueNotification({
        kind: "system",
        dedupeKey: `sys-pause-${Date.now()}`,
        text: "⏸ <b>Sending paused</b>",
        replyMarkup: controlKeyboard(s),
      });
      return "Sending paused";
    }
    if (action === "enable") {
      const current = await getSettings();
      const gate = evaluateSendGate({ ...current, sendingEnabled: true, emergencyStop: false });
      if (!gate.allowed) return `Cannot enable: ${gate.reasons[0]}`;
      const s = await updateSettings({ sendingEnabled: true, emergencyStop: false });
      await audit({ actor: "telegram", action: "sending.enable" });
      await enqueueNotification({
        kind: "system",
        dedupeKey: `sys-enable-${Date.now()}`,
        text: "▶️ <b>Sending enabled</b>",
        replyMarkup: controlKeyboard(s),
      });
      return "Sending enabled";
    }
    if (action === "status") {
      const s = await getSettings();
      const c = await counts();
      const b = await budgetStatus();
      await enqueueNotification({
        kind: "status",
        dedupeKey: `status-${Date.now()}`,
        text: statusText({
          settings: s,
          sentToday: c.sentToday,
          queued: c.queued,
          eligible: c.eligible,
          replies24h: c.replies24h,
          pendingJobs: await pendingJobCount(),
          deadJobs: await deadLetterCount(),
          aiDaily: b.daily,
          aiDailyCap: b.dailyCap,
          gaps: evaluateSendGate(s).reasons,
        }),
        replyMarkup: controlKeyboard(s),
      });
      return "Status sent";
    }
    if (action === "report") {
      await enqueueReportNow();
      return "Report queued";
    }
  }

  if (scope === "rep" && arg) {
    const replyId = Number(arg);
    const [r] = await db.select().from(replies).where(eq(replies.id, replyId)).limit(1);
    if (!r) return "Reply not found";
    if (action === "handled") {
      await db.update(replies).set({ handled: true }).where(eq(replies.id, replyId));
      await audit({ actor: "telegram", action: "reply.handled", entityId: replyId });
      return "Marked handled";
    }
    if (action === "suppress") {
      await suppress({
        email: r.fromEmail,
        reason: "manual",
        sourceRef: `telegram:reply:${replyId}`,
        note: "Suppressed by operator from Telegram",
      });
      if (r.prospectId) {
        const [p] = await db.select().from(prospects).where(eq(prospects.id, r.prospectId));
        if (p && p.status !== "UNSUBSCRIBED") {
          try {
            await transition({
              prospectId: r.prospectId,
              to: "UNSUBSCRIBED",
              reason: "Operator suppression from Telegram",
              actor: "human",
            });
          } catch {
            /* already terminal */
          }
        }
      }
      await audit({ actor: "telegram", action: "reply.suppress", entityId: replyId });
      return "Address suppressed";
    }
  }

  return "Unknown action";
}
