# Security and privacy notes

## Secrets

| Secret | Storage | Protection |
| --- | --- | --- |
| Gmail refresh / access token | `oauth_accounts` | AES-256-GCM (`TOKEN_ENCRYPTION_KEY`), never returned by any endpoint |
| `XAI_API_KEY`, `TELEGRAM_BOT_TOKEN`, client secret | environment only | never read client-side, never persisted |
| Dashboard password | environment only | compared via HMAC + constant-time equality |

`.gitignore` excludes `.env*` (except `.env.example`), `*.pem`, `credentials*.json`,
`client_secret*.json`, and all `reports/`, `exports/`, `*.csv`, `*.xlsx` artefacts.
**No real prospect data or secret is ever committed.**

## Log redaction

`src/lib/log.ts` redacts, in both keys and free text:
Google OAuth tokens (`ya29.`, `1//`), xAI keys (`xai-`), Telegram bot tokens
(`\d{8,10}:[\w-]{30,}`), Google client secrets (`GOCSPX-`), 64-char hex keys, and any
field named `authorization`, `cookie`, `password`, `token`, `*_secret`, `api_key`.
Strings are truncated at 2000 characters. Audit-log payloads pass through the same
redactor before insert. Covered by acceptance test 19.

## Authentication and authorisation

* Dashboard and every `/api/admin/*` route require an HMAC-signed, HttpOnly, SameSite=Lax
  session cookie (12 h TTL, `Secure` when `APP_BASE_URL` is https).
* `/api/telegram/webhook` — `X-Telegram-Bot-Api-Secret-Token` constant-time check **and**
  chat-id allowlist **and** `update_id` replay protection.
* `/api/gmail/push` — shared secret in the push URL **and** Pub/Sub `messageId`
  deduplication. The payload is never trusted; it only triggers a reconciliation job.
* `/api/cron` — `CRON_SECRET` header or an authenticated session.
* OAuth start/callback — authenticated, plus an HMAC-signed, 10-minute `state` nonce
  (CSRF protection).
* `robots: noindex, nofollow` on the console.

## Database

* All queries go through Drizzle's parameterised builder. The few raw statements use
  `sql` tagged templates with bound parameters — no string concatenation of user input.
* Grant the application role rights on its own schema only; do not run as `postgres`.
* Unique constraints (`prospects.email_normalized`, `suppressions.email_normalized`,
  `replies.gmail_message_id`, `jobs.idempotency_key`, `notifications.dedupe_key`,
  `processed_events(source,event_id)`) are the real defence against duplicate work —
  not application-level checks.

## OAuth scope minimisation

`gmail.send` + `gmail.readonly` + `userinfo.email`. Not requested: `gmail.modify`,
`gmail.labels`, `gmail.settings`, contacts, Drive.

## Data minimisation and retention

Only publicly available business contact information is collected. Explicitly **not**
collected: passwords, private account data, leaked databases, unrelated sensitive
personal data.

| Data | Retention | Notes |
| --- | --- | --- |
| Reply body text | truncated to 8000 chars | kept for authorized review of the conversation |
| AI prompts | not stored; only token counts and cost | `redactForAi` strips emails/phones first |
| Report files | stored as `bytea`, downloadable only by the authenticated operator | never written to disk |
| Audit log | indexed by date; prune older than 24 months | |

Suggested quarterly pruning (keep suppressions **forever** — they are the compliance
record):

```sql
DELETE FROM audit_log       WHERE created_at < now() - interval '24 months';
DELETE FROM ai_usage        WHERE created_at < now() - interval '12 months';
DELETE FROM processed_events WHERE created_at < now() - interval '90 days';
UPDATE replies SET body_text = NULL WHERE received_at < now() - interval '18 months';
DELETE FROM reports         WHERE generated_at < now() - interval '12 months';
```

## Subject access / erasure

```sql
-- Export everything held about one person
SELECT * FROM prospects        WHERE email_normalized = :email;
SELECT * FROM evidence_claims  WHERE prospect_id = :id;
SELECT * FROM email_messages   WHERE prospect_id = :id;
SELECT * FROM replies          WHERE prospect_id = :id;
SELECT * FROM state_transitions WHERE prospect_id = :id;

-- Erase. The suppression row is deliberately retained: it is the lawful record of
-- the objection and the only thing preventing re-contact after re-discovery.
DELETE FROM prospects WHERE email_normalized = :email;  -- cascades
INSERT INTO suppressions (email_normalized, reason, note)
VALUES (:email, 'manual', 'erasure request honoured; retained to prevent re-contact')
ON CONFLICT DO NOTHING;
```

## Applicable law — review before live sending

This is an operational summary, not legal advice. Have it confirmed by Indian counsel.

**Digital Personal Data Protection Act, 2023 (India).** Business contact data of an
identified natural person is personal data. Section 3(c)(ii) exempts personal data that
the data principal has **made publicly available themselves** — which is the basis this
system relies on, and exactly why every record must carry a public `source_url` and why
ingestion refuses a prospect without one. Where the exemption does not apply you need a
lawful basis and notice. Honour erasure and objection requests promptly; the opt-out
path above does this. Appoint a grievance contact reachable from
`https://aurumbespoke.com`.

**Information Technology Act, 2000 + SPDI Rules, 2011.** Business contact details are
not "sensitive personal data"; do not collect anything that is.

**Unsolicited commercial communication.** TRAI's UCC/DLT regime governs SMS and voice,
**not** email — so do not assume DLT registration covers this. India has no CAN-SPAM
equivalent for email, which raises rather than lowers the bar: the system therefore
applies CAN-SPAM/GDPR-grade discipline voluntarily — accurate sender identity, truthful
subject, no deceptive headers, a working opt-out honoured permanently and immediately,
a real postal/contact presence and a verified phone number in every message.

**If you ever contact an EU/UK resident**, GDPR/PECR apply: legitimate interest must be
assessed and documented per recipient, and the evidence trail this system stores is what
makes that defensible.

**Gmail Program Policies / Google Terms.** No inbox rotation to evade limits, no
purchased lists, no deceptive content. The 5/day ceiling, single sender and content
validation enforce this in code.

**Robots and source terms.** `robotsAllows()` fails closed; HTTP 401/403/429 and any
CAPTCHA marker abort the fetch and are recorded against the source. CAPTCHAs, logins and
anti-bot protections are never circumvented.
