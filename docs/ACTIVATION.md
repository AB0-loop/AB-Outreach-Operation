# Activation — exact steps to enable production sending

The system ships **safe by default**: `emergencyStop = true`, `sendingEnabled = false`,
no business phone, no credentials, `OUTREACH_MOCK=1`. It cannot send a live email until
everything below is done. No code changes are required.

## A. Prerequisites that need you, not the code

| # | Prerequisite | Why it blocks |
| --- | --- | --- |
| A1 | **Verified Aurum Bespoke business phone number** | Inventing one is forbidden. The send gate and preflight both refuse until it is set and marked verified. |
| A2 | **Always-on host** (`docs/DEPLOYMENT.md`) | No viable free tier keeps a scheduler alive. ~$5–7/mo VPS. Cloudflare Pages/Workers **cannot** run this. |
| A3 | **Google OAuth publication decision** | In *Testing* status the refresh token expires every 7 days. Either submit for verification (restricted scope `gmail.readonly`) or use a Workspace account published internally. |
| A4 | **Funded xAI account** | A consumer Grok subscription is not API credit. |
| A5 | **Gemini quota decision** | Gemini is not guaranteed free. Either fund it or set `geminiEnabled = false`. |
| A6 | **Your account's real Gmail recipient limit** | Set `providerDailyLimit` to the figure you verified for *your* account. The system will not assert an official Google number on your behalf. |
| A7 | **Legal sign-off** on `docs/SECURITY_PRIVACY.md` | DPDP Act 2023 basis + grievance contact. |

A4/A5 are degradable (the system falls back to the neutral template). Everything else is
hard-blocking.

## B. Configuration

```bash
cp .env.example .env && chmod 600 .env
openssl rand -hex 32     # TOKEN_ENCRYPTION_KEY
openssl rand -base64 48  # SESSION_SECRET
openssl rand -hex 24     # TELEGRAM_WEBHOOK_SECRET
openssl rand -hex 32     # CRON_SECRET (only if SCHEDULER_ENABLED=0)
```

Set `OUTREACH_MOCK=0`, a real HTTPS `APP_BASE_URL`, and a strong `ADMIN_PASSWORD`
(≥12 chars). Preflight **fails** on dev-default secrets once mock mode is off.

```bash
npm ci && npx drizzle-kit push && npm run build && npm start
```

## C. Connect integrations

1. `docs/SETUP_GMAIL.md` → dashboard **Connect Gmail** as `connectaurumbespoke@gmail.com`
2. `docs/SETUP_TELEGRAM.md` → `setWebhook` with `allowed_updates=["callback_query"]`
3. `docs/SETUP_AI.md` → verify both `/models` endpoints respond; set model ids

## D. Preflight

Dashboard → **Run preflight**. It verifies, and reports a fix for anything failing:

database + all 20 tables · production secret strength · business phone and brand details ·
Gmail authorisation, scopes and identity match · reply monitoring · Grok and Gemini
reachability · AI budget state · **a real Telegram test delivery** · **a real PDF render** ·
durable serial counter · scheduler and dead-letter queue · suppression/content gates ·
emergency stop · backup reminder.

A present API key is never treated as proof a service works.

## E. Controlled live test — before any real prospect

With `sendingEnabled` still off:

1. Telegram **📊 Status** → confirms webhook, secret and chat id.
2. Telegram **📄 Report Now** → confirms all 7 PDFs arrive as documents with serials.
3. Dashboard → **Send test email** to an address *you control*. Confirm it arrives and
   contains the website, the real phone and the opt-out line.
4. Reply to it → confirm the Telegram alert, the correct Gmail thread link, the
   approval entry, and that the follow-up is cancelled.
5. Reply `UNSUBSCRIBE` from a second address you control → confirm permanent suppression.

Only after step 5 passes should a real prospect be loaded.

## F. Launch

1. Dashboard → verified **business phone** → *Save & mark verified*.
2. Set `providerDailyLimit` to your verified account limit (A6).
3. Import real prospects (each needs a public source URL and evidence).
4. Press **🚀 Launch** — it re-runs preflight and refuses if any critical check fails.

Sending begins at the conservative floor (5/day), Mon–Fri, 10:00–18:00 IST, and only
grows as the measured delivery metrics justify it.

## G. What is actually tested, and what is not

**Tested** — `npm run test`, 37/37 passing, mocked providers and synthetic recipients:
the full cycle discovery → scoring → verification → eligibility → evidence-grounded
drafting → validation → quality review → adaptive budgeting → send → reply
classification → stop rules → suppression → phone capture → appointment state →
human-approval queue → 7-PDF report set with durable serials → Telegram document
delivery; plus the failure paths for Telegram outage, AI failover, Gemini budget
exhaustion, permanent auth failure, suppression-lookup outage, quality-gate rejection,
and emergency stop. Type-check and production build pass.

**Not tested — no credentials exist in this environment:** live Google OAuth consent and
token exchange; a real `messages.send`; real Pub/Sub push; a real billed Grok or Gemini
completion; real Telegram Bot API delivery and button callbacks; a real DNS/TLS
deployment. Section D and E above exist precisely to verify these on your
infrastructure. **No live email has been sent and no report has been delivered to a real
Telegram chat by this build.**
