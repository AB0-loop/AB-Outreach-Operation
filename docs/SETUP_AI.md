# AI providers: Grok (primary) → Gemini (failover)

## 1. Verify billing before you rely on either provider

**A consumer Grok / X Premium subscription is not API credit.** The xAI API is
billed separately at <https://console.x.ai>.

**Gemini is not guaranteed to be free either.** Google AI Studio offers a free
tier with low rate limits that Google may change; paid usage bills through a
Google Cloud project. Confirm your own quota and pricing before enabling
failover.

The system never assumes either is free. Each provider has its own hard daily
USD ceiling, and failover stops at Gemini's ceiling just as it stops at Grok's.

## 2. Keys

```
XAI_API_KEY=xai-...
XAI_BASE_URL=https://api.x.ai/v1

GEMINI_API_KEY=...
GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta
```

Both are read server-side only, are redacted from every log line, and are never
included in a Telegram message. Set the model ids in the dashboard
(`aiModel`, `geminiModel`) to models your keys can actually use.

Verify with `GET /api/health` → `checks.aiPrimary` and `checks.aiFailover`, or
run **Preflight** from the dashboard.

## 3. How failover actually works

`src/lib/providers/ai.ts` is the single entry point for every AI call. Each
provider error is classified, and the classification decides what happens next:

| Error kind | Example | Behaviour |
| --- | --- | --- |
| `rate_limit` | HTTP 429 | **Fail over to Gemini** |
| `quota_exhausted` | 429 mentioning quota/insufficient | **Fail over to Gemini** |
| `outage` | HTTP 5xx | retry with backoff, then fail over |
| `timeout` | request exceeded 45 s | retry with backoff, then fail over |
| `model_error` | unknown model id | **Fail over to Gemini** |
| `auth` | 401/403 | **No retry, no loop** — permanent |
| `billing` | 403 mentioning billing/credit | **No retry** — permanent |
| `invalid_request` | 400 | **No retry** — this is our bug, not capacity |

Additional controls:

* **Per-provider budget gate.** Before any call, that provider's own daily
  spend is checked. Grok hitting its cap does *not* authorise unlimited Gemini
  spend — Gemini is skipped too once `geminiDailyCapUsd` is reached.
* **Circuit breaker.** Three consecutive failures open the provider for 1–60
  minutes (30 min base for quota/billing problems) so a dead provider is not
  hammered.
* **Bounded retries.** At most three attempts per provider, exponential
  backoff, and only for transient kinds.
* **Identical contract.** Both providers receive the same system prompt,
  evidence, factual restrictions and JSON output schema, so a failover cannot
  change what the model is allowed to say.
* **Full ledger.** Every attempt — success, failure, timeout or budget block —
  writes a row to `ai_usage` with provider, model, tokens, latency, status,
  cost and the `failover_reason`.
* **Both down → queue.** `AiUnavailableError` is raised, a Telegram alert
  fires, and the job is retried later. The system falls back to the
  deterministic approved template (which must independently pass every
  validation and quality rule) or defers. **It never substitutes generic or
  unverified copy to keep sending.**

Disable failover entirely with `geminiEnabled = false` in settings.

## 4. Spending controls

| Control | Default | Setting |
| --- | --- | --- |
| Combined daily ceiling | $1.00 | `aiDailyCapUsd` |
| Combined monthly ceiling | $20.00 | `aiMonthlyCapUsd` |
| Grok daily ceiling | $1.00 | `grokDailyCapUsd` |
| Gemini daily ceiling | $0.50 | `geminiDailyCapUsd` |
| Max input tokens / task | 2000 | `aiMaxInputTokens` |
| Max output tokens / task | 600 | `aiMaxOutputTokens` |

At **80%** of a combined ceiling a Telegram warning is sent once. At **100%**
new AI calls are refused, `aiPaused` is set with a reason, and dependent work
is **queued, not dropped**. Resume with the dashboard **Resume AI** button
after raising the cap or topping up.

Cost uses the provider's own figure when returned, otherwise it is computed
from the configured per-million-token rates; the ledger records which
(`provider` vs `estimated`) so the numbers are never silently wrong.

## 5. What the AI is allowed to do

Only four narrow tasks: draft **one** personalised opening sentence from a
stored claim, review draft quality, classify an ambiguous reply, and summarise
a reply.

It cannot decide eligibility, ignore an opt-out, retry a bounce, confirm a
meeting, promise a price or delivery date, bypass validation, or change
prospect state — `canTransition(..., "ai")` always returns `false`.

`redactForAi()` strips email addresses and phone numbers from every prompt and
truncates to 4000 characters.
