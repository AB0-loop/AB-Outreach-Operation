import type { Prospect, Reply, Settings } from "@/db/schema";
import {
  enqueueNotification,
  esc,
  gmailThreadLink,
  truncate,
  type InlineKeyboard,
} from "./providers/telegram";
import { formatZoned } from "./time";

/** The single persistent control surface. No other buttons are sent. */
export function controlKeyboard(s: Settings): InlineKeyboard {
  return {
    inline_keyboard: [
      [
        s.emergencyStop
          ? { text: "✅ Clear Emergency Stop", callback_data: "ctl:resume" }
          : { text: "🛑 EMERGENCY STOP", callback_data: "ctl:stop" },
        s.sendingEnabled && !s.emergencyStop
          ? { text: "⏸ Pause Sending", callback_data: "ctl:pause" }
          : { text: "▶️ Enable Sending", callback_data: "ctl:enable" },
      ],
      [
        { text: "📊 Status", callback_data: "ctl:status" },
        { text: "📄 Report Now", callback_data: "ctl:report" },
      ],
    ],
  };
}

function replyKeyboard(reply: Reply, prospect: Prospect | null): InlineKeyboard {
  const rows: InlineKeyboard["inline_keyboard"] = [
    [{ text: "📬 Open in Gmail", url: gmailThreadLink(reply.gmailThreadId) }],
  ];
  if (prospect) {
    rows.push([
      { text: "✅ Mark handled", callback_data: `rep:handled:${reply.id}` },
      { text: "🚫 Suppress", callback_data: `rep:suppress:${reply.id}` },
    ]);
  }
  return { inline_keyboard: rows };
}

const CLASS_ICON: Record<string, string> = {
  interested: "🟢",
  consultation: "🟢",
  pricing: "🟢",
  decline: "🔴",
  unsubscribe: "⛔",
  complaint: "⛔",
  hard_bounce: "📛",
  soft_bounce: "⚠️",
  auto_reply: "💤",
  ambiguous: "🟡",
};

export async function notifyReply(opts: {
  reply: Reply;
  prospect: Prospect | null;
  settings: Settings;
  followUpStatus: string;
}) {
  const { reply, prospect, settings } = opts;
  const icon = CLASS_ICON[reply.classification] ?? "✉️";

  const lines = [
    `${icon} <b>Reply · ${esc(reply.classification.replace("_", " "))}</b>`,
    "",
    `<b>${esc(prospect?.fullName ?? "Unknown prospect")}</b>${prospect?.company ? ` — ${esc(prospect.company)}` : ""}`,
    prospect?.role ? `Role: ${esc(prospect.role)}` : "",
    `Email: ${esc(reply.fromEmail)}`,
  ];

  if (prospect?.phone)
    lines.push(
      `Business phone: ${esc(prospect.phone)} (${esc(prospect.phoneType ?? "unverified")})`,
    );
  if (reply.extractedPhone)
    lines.push(
      `📱 New number supplied: ${esc(reply.extractedPhone)} — ${
        reply.extractedPhoneOwnership === "stated_by_sender"
          ? "stated by sender"
          : "ownership unverified"
      }`,
    );
  if (prospect)
    lines.push(
      `Segment: ${esc(prospect.segment)} · Source: ${esc(prospect.sourceName ?? "n/a")}`,
    );

  lines.push(
    "",
    `<b>Subject:</b> ${esc(truncate(reply.subject ?? "", 120))}`,
    `<i>${esc(truncate(reply.summary ?? reply.bodyText ?? "", 400))}</i>`,
    "",
    `Received: ${esc(formatZoned(new Date(reply.receivedAt), settings.timezone))}`,
    `Follow-up: ${esc(opts.followUpStatus)}`,
  );
  if (reply.suggestedResponse)
    lines.push("", `<b>Suggested next step:</b> ${esc(truncate(reply.suggestedResponse, 300))}`);

  await enqueueNotification({
    kind: "reply",
    dedupeKey: `reply:${reply.gmailMessageId}`,
    text: lines.filter(Boolean).join("\n"),
    replyMarkup: replyKeyboard(reply, prospect),
  });
}

export async function notifyCritical(opts: {
  title: string;
  detail: string;
  dedupeKey: string;
}) {
  await enqueueNotification({
    kind: "critical",
    dedupeKey: opts.dedupeKey,
    text: `🚨 <b>${esc(opts.title)}</b>\n${esc(truncate(opts.detail, 700))}`,
  });
}

export async function notifySystemState(opts: {
  settings: Settings;
  title: string;
  detail?: string;
  dedupeKey: string;
}) {
  await enqueueNotification({
    kind: "system",
    dedupeKey: opts.dedupeKey,
    text: `⚙️ <b>${esc(opts.title)}</b>${opts.detail ? `\n${esc(opts.detail)}` : ""}`,
    replyMarkup: controlKeyboard(opts.settings),
  });
}

export function statusText(d: {
  settings: Settings;
  sentToday: number;
  queued: number;
  eligible: number;
  replies24h: number;
  pendingJobs: number;
  deadJobs: number;
  aiDaily: number;
  aiDailyCap: number;
  gaps: string[];
}): string {
  const s = d.settings;
  const gate = s.emergencyStop
    ? "🛑 EMERGENCY STOP"
    : s.sendingEnabled
      ? "🟢 Sending enabled"
      : "⏸ Sending paused";
  return [
    `<b>Aurum Bespoke — Status</b>`,
    gate,
    "",
    `Sent today: ${d.sentToday}/${s.currentDailyBudget} (adaptive)`,
    `Queued: ${d.queued} · Eligible: ${d.eligible}`,
    `Replies (24h): ${d.replies24h}`,
    `Jobs pending: ${d.pendingJobs} · dead-letter: ${d.deadJobs}`,
    `AI spend today: $${d.aiDaily.toFixed(4)} / $${d.aiDailyCap.toFixed(2)}`,
    d.gaps.length ? `\n<b>Blockers:</b>\n${d.gaps.map((g) => `• ${esc(g)}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}
