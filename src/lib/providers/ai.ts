import { db } from "@/db";
import { aiUsage } from "@/db/schema";
import { gte, sql, and, eq } from "drizzle-orm";
import { env } from "../env";
import { getSettings, updateSettings } from "../settings";
import { errorMessage, log } from "../log";
import { mockStore } from "./mock";
import { enqueueNotification } from "./telegram";

/* ------------------------------------------------------------------ */
/* Error taxonomy — drives failover vs. abort decisions                */
/* ------------------------------------------------------------------ */
export type AiErrorKind =
  | "rate_limit"
  | "quota_exhausted"
  | "outage"
  | "timeout"
  | "auth"
  | "invalid_request"
  | "billing"
  | "model_error"
  | "budget";

/** Failing over is only sensible for capacity problems, never for our bugs. */
const FAILOVER_KINDS: AiErrorKind[] = [
  "rate_limit",
  "quota_exhausted",
  "outage",
  "timeout",
  "model_error",
];
/** Never retried: retrying cannot fix them and may lock the account. */
const PERMANENT_KINDS: AiErrorKind[] = ["auth", "invalid_request", "billing"];

export class AiError extends Error {
  constructor(
    readonly kind: AiErrorKind,
    readonly provider: Provider,
    message: string,
  ) {
    super(message);
    this.name = "AiError";
  }
  get retryable() {
    return !PERMANENT_KINDS.includes(this.kind);
  }
  get canFailover() {
    return FAILOVER_KINDS.includes(this.kind);
  }
}

/** Raised when all configured providers are unusable. Callers must QUEUE. */
export class AiUnavailableError extends Error {
  constructor(
    message: string,
    readonly detail: { provider: Provider; kind: AiErrorKind; message: string }[] = [],
  ) {
    super(message);
    this.name = "AiUnavailableError";
  }
}

export class AiBudgetExceededError extends AiUnavailableError {}

export type Provider = "grok" | "gemini";
export type AiTask =
  | "draft_email"
  | "classify_reply"
  | "summarize_reply"
  | "quality_review"
  | "score_lead";

export type ChatMessage = { role: "system" | "user"; content: string };

export type AiResult = {
  content: string;
  provider: Provider;
  model: string;
  costUsd: number;
  failedOver: boolean;
};

/* ------------------------------------------------------------------ */
/* Redaction                                                           */
/* ------------------------------------------------------------------ */
export function redactForAi(text: string): string {
  return text
    .replace(/\+?\d[\d\s\-()]{7,}\d/g, "[phone]")
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.]+\b/g, "[email]")
    .slice(0, 4000);
}

/* ------------------------------------------------------------------ */
/* Budget                                                              */
/* ------------------------------------------------------------------ */
async function spend(since: Date, provider?: Provider): Promise<number> {
  const where = provider
    ? and(gte(aiUsage.createdAt, since), eq(aiUsage.provider, provider))
    : gte(aiUsage.createdAt, since);
  const rows = await db
    .select({ total: sql<string>`coalesce(sum(${aiUsage.costUsd}), 0)` })
    .from(aiUsage)
    .where(where);
  return Number(rows[0]?.total ?? 0);
}

export async function budgetStatus() {
  const s = await getSettings();
  const now = new Date();
  const dayStart = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const [daily, monthly, grokDaily, geminiDaily] = await Promise.all([
    spend(dayStart),
    spend(monthStart),
    spend(dayStart, "grok"),
    spend(dayStart, "gemini"),
  ]);
  const dailyCap = Number(s.aiDailyCapUsd);
  const monthlyCap = Number(s.aiMonthlyCapUsd);
  return {
    daily,
    dailyCap,
    monthly,
    monthlyCap,
    grokDaily,
    grokDailyCap: Number(s.grokDailyCapUsd),
    geminiDaily,
    geminiDailyCap: Number(s.geminiDailyCapUsd),
    paused: s.aiPaused,
    pausedReason: s.aiPausedReason,
    dailyPct: dailyCap > 0 ? daily / dailyCap : 0,
    monthlyPct: monthlyCap > 0 ? monthly / monthlyCap : 0,
    exceeded: daily >= dailyCap || monthly >= monthlyCap,
  };
}

/** Per-provider budget gate. Failover must never outspend Gemini's own cap. */
async function providerWithinBudget(p: Provider): Promise<boolean> {
  const b = await budgetStatus();
  if (b.exceeded) return false;
  return p === "grok"
    ? b.grokDaily < b.grokDailyCap
    : b.geminiDaily < b.geminiDailyCap;
}

async function enforceGlobalCeiling() {
  const b = await budgetStatus();
  if (b.exceeded) {
    await updateSettings({
      aiPaused: true,
      aiPausedReason: `Combined AI ceiling reached (daily $${b.daily.toFixed(4)}/$${b.dailyCap}, monthly $${b.monthly.toFixed(4)}/$${b.monthlyCap})`,
    });
    await enqueueNotification({
      kind: "critical",
      dedupeKey: `ai-budget-stop-${new Date().toISOString().slice(0, 13)}`,
      text:
        `🛑 <b>AI spending ceiling reached</b>\n` +
        `Daily $${b.daily.toFixed(4)} / $${b.dailyCap} · Monthly $${b.monthly.toFixed(4)} / $${b.monthlyCap}\n` +
        `New AI calls suspended. Dependent work is queued, not dropped.`,
    });
    throw new AiBudgetExceededError("AI spending ceiling reached");
  }
  if (b.dailyPct >= 0.8 || b.monthlyPct >= 0.8) {
    await enqueueNotification({
      kind: "critical",
      dedupeKey: `ai-budget-warn-${new Date().toISOString().slice(0, 10)}`,
      text: `⚠️ <b>AI spend approaching ceiling</b>\nDaily ${(b.dailyPct * 100).toFixed(0)}% · Monthly ${(b.monthlyPct * 100).toFixed(0)}%`,
    });
  }
}

/* ------------------------------------------------------------------ */
/* Circuit breaker (in-memory, per provider, short-lived)              */
/* ------------------------------------------------------------------ */
type Breaker = { failures: number; openUntil: number };
const g = globalThis as typeof globalThis & {
  __aurumBreakers?: Record<Provider, Breaker>;
};
function breakers() {
  if (!g.__aurumBreakers)
    g.__aurumBreakers = {
      grok: { failures: 0, openUntil: 0 },
      gemini: { failures: 0, openUntil: 0 },
    };
  return g.__aurumBreakers;
}
export function resetBreakers() {
  g.__aurumBreakers = {
    grok: { failures: 0, openUntil: 0 },
    gemini: { failures: 0, openUntil: 0 },
  };
}
function breakerOpen(p: Provider) {
  return breakers()[p].openUntil > Date.now();
}
function recordFailure(p: Provider, kind: AiErrorKind) {
  const b = breakers()[p];
  b.failures += 1;
  // Quota/billing problems stay open far longer than a transient blip.
  const base = kind === "quota_exhausted" || kind === "billing" ? 30 * 60_000 : 60_000;
  if (b.failures >= 3) b.openUntil = Date.now() + Math.min(base * b.failures, 60 * 60_000);
}
function recordSuccess(p: Provider) {
  breakers()[p] = { failures: 0, openUntil: 0 };
}

/* ------------------------------------------------------------------ */
/* Usage ledger                                                        */
/* ------------------------------------------------------------------ */
async function record(entry: typeof aiUsage.$inferInsert) {
  await db.insert(aiUsage).values(entry);
}

/* ------------------------------------------------------------------ */
/* HTTP status -> error kind                                           */
/* ------------------------------------------------------------------ */
function kindFromStatus(status: number, body: string): AiErrorKind {
  const b = body.toLowerCase();
  if (status === 401 || status === 403) {
    if (b.includes("billing") || b.includes("payment") || b.includes("credit"))
      return "billing";
    return "auth";
  }
  if (status === 429) {
    return b.includes("quota") || b.includes("exhaust") || b.includes("insufficient")
      ? "quota_exhausted"
      : "rate_limit";
  }
  if (status === 400 || status === 404 || status === 422) {
    return b.includes("model") ? "model_error" : "invalid_request";
  }
  if (status >= 500) return "outage";
  return "outage";
}

/* ------------------------------------------------------------------ */
/* Provider calls                                                      */
/* ------------------------------------------------------------------ */
type RawResult = { content: string; promptTokens: number; completionTokens: number; providerCost?: number };

async function callGrok(
  messages: ChatMessage[],
  model: string,
  maxTokens: number,
  timeoutMs: number,
): Promise<RawResult> {
  const apiKey = env.xaiApiKey;
  if (!apiKey) throw new AiError("auth", "grok", "XAI_API_KEY is not configured");
  const res = await fetch(`${env.xaiBaseUrl}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0.4, stream: false }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new AiError(kindFromStatus(res.status, body), "grok", `${res.status}: ${body.slice(0, 180)}`);
  }
  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
    usage?: { prompt_tokens?: number; completion_tokens?: number; total_cost?: number };
  };
  return {
    content: json.choices?.[0]?.message?.content ?? "",
    promptTokens: json.usage?.prompt_tokens ?? 0,
    completionTokens: json.usage?.completion_tokens ?? 0,
    providerCost: json.usage?.total_cost,
  };
}

async function callGemini(
  messages: ChatMessage[],
  model: string,
  maxTokens: number,
  timeoutMs: number,
): Promise<RawResult> {
  const apiKey = env.geminiApiKey;
  if (!apiKey) throw new AiError("auth", "gemini", "GEMINI_API_KEY is not configured");

  // Gemini takes the system prompt separately from the user turns.
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
  const user = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n");

  const res = await fetch(
    `${env.geminiBaseUrl}/models/${encodeURIComponent(model)}:generateContent`,
    {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
        contents: [{ role: "user", parts: [{ text: user }] }],
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0.4 },
      }),
      signal: AbortSignal.timeout(timeoutMs),
    },
  );
  if (!res.ok) {
    const body = await res.text();
    throw new AiError(kindFromStatus(res.status, body), "gemini", `${res.status}: ${body.slice(0, 180)}`);
  }
  const json = (await res.json()) as {
    candidates?: { content?: { parts?: { text?: string }[] } }[];
    usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  };
  const content =
    json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? "").join("") ?? "";
  return {
    content,
    promptTokens: json.usageMetadata?.promptTokenCount ?? 0,
    completionTokens: json.usageMetadata?.candidatesTokenCount ?? 0,
  };
}

function mockCall(provider: Provider, task: AiTask, messages: ChatMessage[]): RawResult {
  const store = mockStore();
  const fail = provider === "grok" ? store.failGrok : store.failGemini;
  if (fail === "timeout") throw new AiError("timeout", provider, "mock timeout");
  if (fail === "rate_limit") throw new AiError("rate_limit", provider, "mock rate limit");
  if (fail === "quota") throw new AiError("quota_exhausted", provider, "mock quota exhausted");
  if (fail === "auth") throw new AiError("auth", provider, "mock auth failure");
  if (fail === "error") throw new AiError("outage", provider, "mock outage");
  store.aiCalls.push({ provider, task });
  return { content: mockCompletion(task, messages), promptTokens: 120, completionTokens: 90 };
}

/* ------------------------------------------------------------------ */
/* Public entrypoint — identical contract for both providers           */
/* ------------------------------------------------------------------ */
export async function aiComplete(opts: {
  task: AiTask;
  messages: ChatMessage[];
  maxOutputTokens?: number;
  timeoutMs?: number;
}): Promise<AiResult> {
  const s = await getSettings();
  if (s.aiPaused)
    throw new AiUnavailableError(s.aiPausedReason ?? "AI is paused by the operator");
  await enforceGlobalCeiling();

  const maxTokens = Math.min(opts.maxOutputTokens ?? s.aiMaxOutputTokens, s.aiMaxOutputTokens);
  const timeoutMs = opts.timeoutMs ?? 45000;
  const inputChars = opts.messages.reduce((a, m) => a + m.content.length, 0);
  if (inputChars / 4 > s.aiMaxInputTokens)
    throw new AiUnavailableError("Prompt exceeds the configured input token budget");

  const chain: Provider[] = ["grok", ...(s.geminiEnabled ? (["gemini"] as Provider[]) : [])];
  const failures: { provider: Provider; kind: AiErrorKind; message: string }[] = [];
  let failoverReason: string | null = null;

  for (const provider of chain) {
    const model = provider === "grok" ? s.aiModel : s.geminiModel;

    if (breakerOpen(provider)) {
      failures.push({ provider, kind: "outage", message: "circuit breaker open" });
      failoverReason ??= `${provider}: circuit breaker open`;
      continue;
    }
    // Budget is checked per provider: failover never outspends its own cap.
    if (!(await providerWithinBudget(provider))) {
      failures.push({ provider, kind: "budget", message: "provider daily cap reached" });
      await record({ task: opts.task, provider, model, status: "budget_blocked", error: "provider daily cap reached" });
      failoverReason ??= `${provider}: daily cap reached`;
      continue;
    }

    // Bounded retries with exponential backoff, only for transient kinds.
    for (let attempt = 1; attempt <= 3; attempt++) {
      const started = Date.now();
      try {
        const raw = env.mockMode
          ? mockCall(provider, opts.task, opts.messages)
          : provider === "grok"
            ? await callGrok(opts.messages, model, maxTokens, timeoutMs)
            : await callGemini(opts.messages, model, maxTokens, timeoutMs);

        if (!raw.content.trim()) throw new AiError("model_error", provider, "empty response");

        const inRate = provider === "grok" ? Number(s.aiInputUsdPerMTok) : Number(s.geminiInputUsdPerMTok);
        const outRate = provider === "grok" ? Number(s.aiOutputUsdPerMTok) : Number(s.geminiOutputUsdPerMTok);
        const costUsd =
          typeof raw.providerCost === "number"
            ? raw.providerCost
            : (raw.promptTokens / 1e6) * inRate + (raw.completionTokens / 1e6) * outRate;

        await record({
          task: opts.task,
          provider,
          model,
          failoverReason: provider !== chain[0] ? failoverReason : null,
          promptTokens: raw.promptTokens,
          completionTokens: raw.completionTokens,
          costUsd: costUsd.toFixed(6),
          costSource: typeof raw.providerCost === "number" ? "provider" : "estimated",
          status: "ok",
          latencyMs: Date.now() - started,
        });
        recordSuccess(provider);

        if (provider !== chain[0]) {
          await enqueueNotification({
            kind: "critical",
            dedupeKey: `ai-failover-${new Date().toISOString().slice(0, 13)}`,
            text: `🔁 <b>AI failover active</b>\nGrok unavailable (${failoverReason}). Using Gemini within its own budget.`,
          });
        }
        return { content: raw.content, provider, model, costUsd, failedOver: provider !== chain[0] };
      } catch (e) {
        const err =
          e instanceof AiError
            ? e
            : new AiError(
                e instanceof Error && /timeout|abort/i.test(e.message) ? "timeout" : "outage",
                provider,
                errorMessage(e),
              );
        await record({
          task: opts.task,
          provider,
          model,
          status: err.kind,
          error: err.message.slice(0, 400),
          latencyMs: Date.now() - started,
        });
        recordFailure(provider, err.kind);

        const lastAttempt = attempt === 3;
        if (!err.retryable || err.canFailover || lastAttempt) {
          failures.push({ provider, kind: err.kind, message: err.message });
          failoverReason ??= `${provider}: ${err.kind}`;
          break; // permanent, or hand over to the next provider
        }
        await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
      }
    }
  }

  log.warn("ai_all_providers_failed", { task: opts.task, failures });
  await enqueueNotification({
    kind: "critical",
    dedupeKey: `ai-down-${new Date().toISOString().slice(0, 13)}`,
    text:
      `🚨 <b>All AI providers unavailable</b>\n` +
      failures.map((f) => `${f.provider}: ${f.kind}`).join("\n") +
      `\nAI-dependent work is queued. No generic copy will be substituted.`,
  });
  throw new AiUnavailableError("All configured AI providers are unavailable", failures);
}

/* ------------------------------------------------------------------ */
/* Health                                                              */
/* ------------------------------------------------------------------ */
export async function providerHealth(p: Provider): Promise<{ ok: boolean; detail: string }> {
  if (env.mockMode) return { ok: true, detail: "mock mode" };
  const key = p === "grok" ? env.xaiApiKey : env.geminiApiKey;
  if (!key)
    return { ok: false, detail: `${p === "grok" ? "XAI_API_KEY" : "GEMINI_API_KEY"} not configured` };
  try {
    const url =
      p === "grok"
        ? `${env.xaiBaseUrl}/models`
        : `${env.geminiBaseUrl}/models`;
    const res = await fetch(url, {
      headers: p === "grok" ? { authorization: `Bearer ${key}` } : { "x-goog-api-key": key },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { ok: false, detail: `models endpoint ${res.status}` };
    const json = (await res.json()) as { data?: unknown[]; models?: unknown[] };
    return { ok: true, detail: `${(json.data ?? json.models ?? []).length} models reachable` };
  } catch (e) {
    return { ok: false, detail: errorMessage(e) };
  }
}

/* ------------------------------------------------------------------ */
/* Deterministic mock completions                                      */
/* ------------------------------------------------------------------ */
function mockCompletion(task: AiTask, messages: ChatMessage[]): string {
  const user = messages.map((m) => m.content).join("\n");
  if (task === "classify_reply") {
    const l = user.toLowerCase();
    const cat = l.includes("price") || l.includes("cost")
      ? "pricing"
      : l.includes("call") || l.includes("meet") || l.includes("appointment")
        ? "consultation"
        : l.includes("interested") || l.includes("sounds good")
          ? "interested"
          : l.includes("not interested")
            ? "decline"
            : "ambiguous";
    return JSON.stringify({ classification: cat, confidence: 0.82 });
  }
  if (task === "summarize_reply") {
    return JSON.stringify({
      summary: "Prospect replied to the outreach email and asked a follow-up question.",
      suggested_response:
        "Thank them, confirm availability for a fitting consultation, and share the website.",
    });
  }
  if (task === "quality_review") {
    return JSON.stringify({
      score: 88,
      issues: [],
      verdict: "pass",
      notes: "Hook is evidence-backed; tone is measured and professional.",
    });
  }
  if (task === "score_lead") {
    return JSON.stringify({ score: 78, reason: "Senior decision-maker in Bengaluru with a verified public role." });
  }
  const name = /NAME: (.+)/.exec(user)?.[1]?.trim() ?? "there";
  const claim = /CLAIM: (.+)/.exec(user)?.[1]?.trim();
  return JSON.stringify({
    subject: "Bespoke tailoring in Bengaluru",
    opening_line: claim
      ? `I came across your work ${claim}.`
      : `I am writing to senior professionals in Bengaluru about bespoke tailoring.`,
    hook_summary: claim ?? "neutral professional context",
    _name: name,
  });
}

export function safeJson<T>(raw: string): T | null {
  const cleaned = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1) return null;
  try {
    return JSON.parse(cleaned.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}
