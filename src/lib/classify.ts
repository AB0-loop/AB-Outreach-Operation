import {
  aiComplete,
  AiUnavailableError,
  redactForAi,
  safeJson,
} from "./providers/ai";

export type ReplyClassification =
  | "unsubscribe"
  | "complaint"
  | "hard_bounce"
  | "soft_bounce"
  | "decline"
  | "interested"
  | "consultation"
  | "pricing"
  | "auto_reply"
  | "ambiguous";

/** Deterministic stop rules run FIRST and can never be overridden by AI. */
export function deterministicClassify(input: {
  fromEmail: string;
  subject: string;
  body: string;
}): ReplyClassification | null {
  const from = input.fromEmail.toLowerCase();
  const subject = (input.subject ?? "").toLowerCase();
  const body = (input.body ?? "").toLowerCase();
  const text = `${subject}\n${body}`;

  const isDaemon =
    /mailer-daemon|postmaster|no-?reply@.*(google|mail)/.test(from) ||
    /delivery status notification|undeliverable|returned mail|mail delivery (failed|subsystem)/.test(
      subject,
    );
  if (isDaemon) {
    if (
      /\b5\.\d\.\d\b/.test(text) ||
      /address not found|user unknown|no such user|does not exist|recipient rejected|550/.test(text)
    )
      return "hard_bounce";
    if (/\b4\.\d\.\d\b|temporar|try again|quota exceeded|mailbox full/.test(text))
      return "soft_bounce";
    return "hard_bounce";
  }

  if (/this is a spam|marked as spam|abuse report|feedback-id/.test(text))
    return "complaint";

  if (
    /\b(unsubscribe|opt[- ]?out|remove me|take me off|stop emailing|do not (email|contact)|don'?t (email|contact) me)\b/.test(
      text,
    ) ||
    /^\s*stop\s*$/i.test((input.body ?? "").trim())
  )
    return "unsubscribe";

  if (/out of (the )?office|on (vacation|leave|holiday)|auto(-| )?reply|automatic reply/.test(text))
    return "auto_reply";

  if (/\b(not interested|no thanks|no thank you|we('| a)re good|not for us|please stop)\b/.test(text))
    return "decline";

  return null;
}

export type ClassificationResult = {
  classification: ReplyClassification;
  by: "rules" | "ai";
  summary: string | null;
  suggestedResponse: string | null;
};

export async function classifyReply(input: {
  fromEmail: string;
  subject: string;
  body: string;
}): Promise<ClassificationResult> {
  const deterministic = deterministicClassify(input);
  if (deterministic) {
    return {
      classification: deterministic,
      by: "rules",
      summary: null,
      suggestedResponse: null,
    };
  }

  try {
    const res = await aiComplete({
      task: "classify_reply",
      maxOutputTokens: 300,
      messages: [
        {
          role: "system",
          content:
            "Classify a reply to a B2B outreach email. Allowed values: interested, consultation, pricing, decline, ambiguous. " +
            'Respond with JSON only: {"classification": string, "summary": string, "suggested_response": string}. ' +
            "summary <= 240 chars, factual, no invented details. suggested_response is a short instruction for a human, not a sendable email.",
        },
        { role: "user", content: redactForAi(`SUBJECT: ${input.subject}\nBODY: ${input.body}`) },
      ],
    });
    const parsed = safeJson<{
      classification?: string;
      summary?: string;
      suggested_response?: string;
    }>(res.content);
    const allowed: ReplyClassification[] = [
      "interested",
      "consultation",
      "pricing",
      "decline",
      "ambiguous",
    ];
    const cls = allowed.includes(parsed?.classification as ReplyClassification)
      ? (parsed!.classification as ReplyClassification)
      : "ambiguous";
    return {
      classification: cls,
      by: "ai",
      summary: parsed?.summary?.slice(0, 400) ?? null,
      suggestedResponse: parsed?.suggested_response?.slice(0, 600) ?? null,
    };
  } catch (e) {
    if (!(e instanceof AiUnavailableError)) throw e;
    // AI unavailable → route to a human, never guess.
    return {
      classification: "ambiguous",
      by: "rules",
      summary: "AI classification unavailable; routed for human review.",
      suggestedResponse: null,
    };
  }
}

const PHONE_RE =
  /(?:\+?91[\s-]?)?(?:0)?([6-9]\d{4}[\s-]?\d{5}|[6-9]\d{9})\b|\b0?(?:80)[\s-]?\d{4}[\s-]?\d{4}\b/g;

export type ExtractedPhone = {
  phone: string;
  ownership: "stated_by_sender" | "uncertain";
};

/**
 * Extracts a phone number only when the sender explicitly supplies it.
 * Ownership is marked uncertain unless the surrounding text establishes it.
 */
export function extractPhone(body: string): ExtractedPhone | null {
  if (!body) return null;
  const matches = body.match(PHONE_RE);
  if (!matches || matches.length === 0) return null;
  const raw = matches[0].trim();
  const digits = raw.replace(/\D/g, "");
  const normalized = digits.length === 10 ? `+91${digits}` : `+${digits.replace(/^0+/, "")}`;

  const window = body.slice(
    Math.max(0, body.indexOf(raw) - 120),
    body.indexOf(raw) + raw.length + 40,
  );
  const ownsIt =
    /\b(my|mine|me at|reach me|call me|contact me|whatsapp me|i am on|i'?m on|my number|cell|mobile)\b/i.test(
      window,
    );
  return { phone: normalized, ownership: ownsIt ? "stated_by_sender" : "uncertain" };
}

/* ------------------------------------------------------------------ */
/* Appointment intent — deterministic, never AI-asserted               */
/* ------------------------------------------------------------------ */

export type AppointmentSignal = {
  status: "proposed" | "awaiting_confirmation" | "confirmed" | "rescheduled" | "cancelled";
  evidenceExcerpt: string;
};

const CONFIRM_RE =
  /\b(confirmed|that works|works for me|see you (then|on)|i'?ll be there|booked|let'?s do (it|that)|agreed)\b/i;
const RESCHEDULE_RE = /\b(reschedul\w+|move (it|the meeting)|another (time|day)|postpone|push (it )?to)\b/i;
const CANCEL_RE = /\b(cancel\w*|can'?t make it|unable to attend|call it off)\b/i;
const REQUEST_RE =
  /\b(meet|meeting|appointment|consultation|fitting|call|visit|come (by|over)|schedule|available|availability|free on)\b/i;

/**
 * Detects consultation intent from the reply text only.
 * A meeting is NEVER marked confirmed without an explicit confirmation phrase
 * in the prospect's own words — the matched excerpt is stored as evidence.
 */
export function detectAppointment(body: string): AppointmentSignal | null {
  if (!body) return null;
  const sentences = body.split(/(?<=[.!?\n])\s+/).filter((x) => x.trim().length > 0);
  const find = (re: RegExp) => sentences.find((s) => re.test(s));

  const cancel = find(CANCEL_RE);
  if (cancel) return { status: "cancelled", evidenceExcerpt: cancel.trim().slice(0, 300) };

  const resched = find(RESCHEDULE_RE);
  if (resched) return { status: "rescheduled", evidenceExcerpt: resched.trim().slice(0, 300) };

  const confirm = find(CONFIRM_RE);
  if (confirm && REQUEST_RE.test(body))
    return { status: "confirmed", evidenceExcerpt: confirm.trim().slice(0, 300) };

  const request = find(REQUEST_RE);
  if (request) {
    // The prospect asked; we have not yet agreed a time.
    return { status: "awaiting_confirmation", evidenceExcerpt: request.trim().slice(0, 300) };
  }
  return null;
}

/** Classifications that permanently stop a sequence. */
export const STOP_CLASSIFICATIONS: ReplyClassification[] = [
  "unsubscribe",
  "complaint",
  "hard_bounce",
  "decline",
];

/** Classifications that trigger an immediate operator alert. */
export const ALERT_CLASSIFICATIONS: ReplyClassification[] = [
  "interested",
  "consultation",
  "pricing",
  "unsubscribe",
  "complaint",
  "hard_bounce",
  "decline",
  "ambiguous",
];
