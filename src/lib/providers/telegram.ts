import { db } from "@/db";
import { notifications } from "@/db/schema";
import { and, asc, eq, lte, or, sql } from "drizzle-orm";
import { env } from "../env";
import { log, errorMessage } from "../log";
import { mockStore } from "./mock";

const API = "https://api.telegram.org";

export type InlineButton =
  | { text: string; callback_data: string }
  | { text: string; url: string };

export type InlineKeyboard = { inline_keyboard: InlineButton[][] };

/** Escape untrusted text for Telegram HTML parse mode. */
export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function truncate(value: string, max = 400): string {
  const v = value.replace(/\s+/g, " ").trim();
  return v.length > max ? `${v.slice(0, max)}…` : v;
}

/**
 * Durable enqueue. Telegram delivery failure can never lose a reply or report:
 * the row persists until delivered or dead-lettered.
 */
export async function enqueueNotification(opts: {
  kind: string;
  text: string;
  dedupeKey: string;
  replyMarkup?: InlineKeyboard;
  documentName?: string;
  documentContent?: Buffer;
}): Promise<number | null> {
  const [row] = await db
    .insert(notifications)
    .values({
      kind: opts.kind,
      text: opts.text,
      dedupeKey: opts.dedupeKey,
      replyMarkup: opts.replyMarkup ?? null,
      documentName: opts.documentName ?? null,
      documentContent: opts.documentContent ?? null,
    })
    .onConflictDoNothing({ target: notifications.dedupeKey })
    .returning({ id: notifications.id });
  return row?.id ?? null;
}

async function callTelegram(
  method: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; messageId?: string; error?: string }> {
  if (env.mockMode) {
    const store = mockStore();
    if (store.failTelegram) return { ok: false, error: "mock telegram down" };
    store.telegram.push({
      method,
      text: String(body.text ?? body.caption ?? ""),
      replyMarkup: body.reply_markup,
    });
    return { ok: true, messageId: `tg-${store.telegram.length}` };
  }

  const token = env.telegramBotToken;
  if (!token) return { ok: false, error: "TELEGRAM_BOT_TOKEN not configured" };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(`${API}/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const json = (await res.json()) as {
      ok: boolean;
      description?: string;
      result?: { message_id?: number };
    };
    if (!json.ok) return { ok: false, error: json.description ?? "unknown" };
    return { ok: true, messageId: String(json.result?.message_id ?? "") };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  } finally {
    clearTimeout(timer);
  }
}

async function sendDocument(
  name: string,
  content: Buffer,
  caption: string,
): Promise<{ ok: boolean; error?: string }> {
  if (env.mockMode) {
    const store = mockStore();
    if (store.failTelegram) return { ok: false, error: "mock telegram down" };
    store.telegram.push({ method: "sendDocument", documentName: name, text: caption });
    return { ok: true };
  }
  const token = env.telegramBotToken;
  const chatId = env.telegramChatId;
  if (!token || !chatId) return { ok: false, error: "Telegram not configured" };

  const form = new FormData();
  form.append("chat_id", chatId);
  form.append("caption", caption.slice(0, 1000));
  form.append("parse_mode", "HTML");
  form.append(
    "document",
    new Blob([new Uint8Array(content)], { type: "application/octet-stream" }),
    name,
  );
  try {
    const res = await fetch(`${API}/bot${token}/sendDocument`, {
      method: "POST",
      body: form,
    });
    const json = (await res.json()) as { ok: boolean; description?: string };
    return json.ok ? { ok: true } : { ok: false, error: json.description };
  } catch (e) {
    return { ok: false, error: errorMessage(e) };
  }
}

/** Drains the notification outbox with exponential backoff. */
export async function flushNotifications(limit = 10): Promise<number> {
  // Compare against the database clock so app/DB skew can never strand a
  // queued notification.
  const pending = await db
    .select()
    .from(notifications)
    .where(
      and(
        or(eq(notifications.status, "pending"), eq(notifications.status, "failed")),
        lte(notifications.nextAttemptAt, sql`now()`),
      ),
    )
    .orderBy(asc(notifications.id))
    .limit(limit);

  let delivered = 0;
  for (const n of pending) {
    const attempts = n.attempts + 1;
    let result: { ok: boolean; error?: string; messageId?: string };

    if (n.documentContent && n.documentName) {
      result = await sendDocument(
        n.documentName,
        Buffer.from(n.documentContent),
        n.text,
      );
    } else {
      result = await callTelegram("sendMessage", {
        chat_id: env.telegramChatId ?? "mock-chat",
        text: n.text,
        parse_mode: "HTML",
        disable_web_page_preview: true,
        ...(n.replyMarkup ? { reply_markup: n.replyMarkup } : {}),
      });
    }

    if (result.ok) {
      delivered += 1;
      await db
        .update(notifications)
        .set({
          status: "sent",
          attempts,
          sentAt: new Date(),
          telegramMessageId: result.messageId ?? null,
          lastError: null,
        })
        .where(eq(notifications.id, n.id));
    } else {
      const dead = attempts >= n.maxAttempts;
      const backoffMs = Math.min(2 ** attempts * 15000, 3600_000);
      await db
        .update(notifications)
        .set({
          status: dead ? "dead" : "failed",
          attempts,
          lastError: result.error?.slice(0, 500) ?? "unknown",
          nextAttemptAt: new Date(Date.now() + backoffMs),
        })
        .where(eq(notifications.id, n.id));
      log.warn("telegram_delivery_failed", { id: n.id, attempts, dead });
    }
  }
  return delivered;
}

export async function answerCallbackQuery(id: string, text: string) {
  await callTelegram("answerCallbackQuery", {
    callback_query_id: id,
    text: text.slice(0, 190),
  });
}

export function gmailThreadLink(threadId: string): string {
  return `https://mail.google.com/mail/u/0/#all/${threadId}`;
}
