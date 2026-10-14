/**
 * Logging with mandatory secret redaction. Never log raw request bodies from
 * providers; always pass values through `redact`.
 */

const SECRET_PATTERNS: RegExp[] = [
  /\b(ya29|1\/\/)[A-Za-z0-9._\-/+]{10,}/g, // Google OAuth tokens
  /\bxai-[A-Za-z0-9]{10,}/g, // xAI keys
  /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/g, // Telegram bot tokens
  /\bGOCSPX-[A-Za-z0-9_-]{10,}/g, // Google client secrets
  /\b[A-Fa-f0-9]{64}\b/g, // hex keys
];

const SECRET_KEYS =
  /^(authorization|cookie|set-cookie|password|token|access_token|refresh_token|client_secret|api_?key|secret)$/i;

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth]";
  if (typeof value === "string") {
    let out = value;
    for (const re of SECRET_PATTERNS) out = out.replace(re, "[REDACTED]");
    return out.length > 2000 ? `${out.slice(0, 2000)}…[truncated]` : out;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k) ? "[REDACTED]" : redact(v, depth + 1);
    }
    return out;
  }
  return value;
}

function emit(level: string, msg: string, meta?: unknown) {
  const line = {
    t: new Date().toISOString(),
    level,
    msg,
    ...(meta !== undefined ? { meta: redact(meta) } : {}),
  };
  const text = JSON.stringify(line);
  if (level === "error") console.error(text);
  else console.log(text);
}

export const log = {
  info: (msg: string, meta?: unknown) => emit("info", msg, meta),
  warn: (msg: string, meta?: unknown) => emit("warn", msg, meta),
  error: (msg: string, meta?: unknown) => emit("error", msg, meta),
};

export function errorMessage(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return String(redact(raw));
}
