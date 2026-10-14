# Telegram bot and control surface

## 1. Create the bot

1. Message [@BotFather](https://t.me/BotFather) → `/newbot` →
   name `Aurum Bespoke Outreach`, username e.g. `aurum_bespoke_ops_bot`.
2. Copy the token → `TELEGRAM_BOT_TOKEN`.
3. `/setprivacy` → **Enable** (the bot only needs callback buttons, not chat history).

## 2. Get the chat id

Send one message to your bot, then:

```bash
curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getUpdates" \
  | grep -o '"chat":{"id":[-0-9]*'
```

```
TELEGRAM_CHAT_ID=<that id>
```

Only this chat id may operate the controls; any other chat is rejected.

## 3. Register the webhook (required for buttons)

```bash
TELEGRAM_WEBHOOK_SECRET=$(openssl rand -hex 24)

curl -s -X POST "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook" \
  -d "url=https://<your-domain>/api/telegram/webhook" \
  -d "secret_token=$TELEGRAM_WEBHOOK_SECRET" \
  -d 'allowed_updates=["callback_query"]'
```

`allowed_updates=["callback_query"]` means Telegram sends **nothing except button
presses** — no message traffic, no noise.

Every update is verified against the `X-Telegram-Bot-Api-Secret-Token` header with a
constant-time comparison, deduplicated on `update_id` (replay protection), and
restricted to `TELEGRAM_CHAT_ID`.

## 4. Control buttons

A single, persistent control row is attached to system messages:

| Button | Effect |
| --- | --- |
| 🛑 **EMERGENCY STOP** | Blocks all new outbound email and follow-ups instantly. Deletes nothing. |
| ✅ **Clear Emergency Stop** | Lifts the stop. Sending stays paused until separately enabled. |
| ⏸ **Pause Sending** / ▶️ **Enable Sending** | Normal pause/resume. Enable is refused if the send gate is not satisfied (e.g. no verified phone). |
| 📊 **Status** | Sends a single status message: sent today / cap, queued, eligible, replies 24h, jobs, AI spend, blockers. |
| 📄 **Report Now** | Queues an immediate report. |

Reply alerts carry only three buttons:

| Button | Effect |
| --- | --- |
| 📬 **Open in Gmail** | Deep link `https://mail.google.com/mail/u/0/#all/{THREAD_ID}` built from the **stored** thread id of that conversation |
| ✅ **Mark handled** | Marks the reply handled |
| 🚫 **Suppress** | Permanent global suppression + `UNSUBSCRIBED` |

## 5. What is sent — and what is never sent

Notifications are emitted **only** for the events in specification section 13:
prospect interest, consultation/pricing request, a newly supplied number, opt-out or
refusal, bounce or complaint, an unclassifiable reply, a critical failure, a pause or
resume, and the daily report. **Nothing else.** There are no per-send notifications, no
"job completed" chatter and no heartbeats.

Every notification is deduplicated by a `dedupe_key` (the Gmail message id for replies,
the report key for reports), so a retry or a replayed event never produces a second
alert.

All untrusted text is HTML-escaped and truncated. Secrets are never interpolated.

## 6. Durability

Notifications are written to the `notifications` table **first**, then delivered by the
scheduler with exponential backoff (up to 8 attempts, capped at 1 hour). A Telegram
outage therefore cannot lose a reply alert or a report — the rows stay queued and go out
when the API recovers. Exhausted rows become `dead` and are surfaced on the dashboard.

Report delivery is reconciled separately: a report is only marked `delivered` once both
its CSV and XLSX documents are confirmed `sent`.
