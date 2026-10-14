# Automated tests

```bash
npm run test
```

**37 tests, all passing.** They run against a real local PostgreSQL with all four
external providers mocked (`OUTREACH_MOCK=1`) and synthetic
`@outreach-test.example.com` recipients. No real prospect is ever contacted.

## Mapping to specification §17

| # | Required coverage | Test(s) |
| --- | --- | --- |
| 1 | New prospect discovery and duplicate prevention | `01` |
| 2 | Verification evidence and provenance | `02`, `28` |
| 3 | Personalisation based on real evidence | `04`, `26` |
| 4 | Rejection of unsupported or generic drafts | `04`, `26`, `27` |
| 5 | Correct sender identity and email content | `05`, `20` |
| 6 | Gmail sending and message-state persistence | `20`, `25` |
| 7 | Retry behaviour without duplicate emails | `01`, `16`, `17` |
| 8 | Reply detection and classification | `20`, `21` |
| 9 | Immediate cancellation of follow-ups after replies | `06` |
| 10 | Opt-out suppression across all segments | `07` |
| 11 | Adaptive sending-budget decisions | `22`, `23`, `24`, `25` |
| 12 | Automatic Grok→Gemini failover | `15a`, `15b` |
| 13 | Failure when both AI providers are unavailable | `15` |
| 14 | API authentication failures and exhausted quotas | `15b`, `15c` |
| 15 | Telegram alerts and action handling | `11`, `14` |
| 16 | PDF generation, readability and required fields | `12` |
| 17 | Separate event-planner reporting | `12b` |
| 18 | Serial generation, concurrency safety, rollover | `12c` |
| 19 | Persistent report storage and delivery retries | `14` |
| 20 | Database restart and recovery | `17` |
| 21 | Emergency-stop behaviour | `18` |
| 22 | Missing configuration and failed preflight | `03`, `31` |
| 23 | Authentication, authorisation and secret redaction | `19` |
| 24 | Scheduled-job execution and recovery from missed runs | `17`, `25` |
| — | Hard bounce stops the sequence | `08` |
| — | Duplicate Gmail events create no duplicates | `09` |
| — | Supplied phone stored with source + verification | `10` |
| — | Appointments never confirmed without evidence | `29` |
| — | Substantive sales replies require human approval | `30` |

### Notable assertions

* **`12c` serials** — 25 concurrent `allocateSerial()` calls yield 25 distinct values
  `001..025`; forcing the counter to 998 produces `999` (cycle 1) then `001` (cycle 2)
  with a distinct `_c2` filename; the counter is re-read from PostgreSQL to prove it
  survives a restart.
* **`15c` budget-respecting failover** — with `geminiDailyCapUsd = 0`, a Grok rate limit
  does **not** reach Gemini. A `budget_blocked` ledger row is written and zero provider
  calls are made. The same holds with `geminiEnabled = false`.
* **`15b` no retry storm** — with both providers returning `auth`, exactly two ledger
  rows exist (one attempt per provider).
* **`24` strictest limit binds** — with a 100% growth step, ceiling 40 and
  operator-verified provider limit 10, the budget stops at 10 and reports
  `provider_limit` as the binding constraint.
* **`27` quality gate** — an unreachable `minQualityScore` blocks the send and moves the
  prospect to `REVIEW` rather than lowering the bar.
* **`12` PDFs** — each of the 7 files begins with `%PDF`, exceeds 1 KB, has a SHA-256
  checksum and a recorded byte size, and every stored filename ends in `.pdf`.

## Mock transports and failure injection

`src/lib/providers/mock.ts` holds the fake Gmail mailbox, Telegram call log, AI call log
and failure switches: `failTelegram`, `failGmailSend`, and `failGrok` / `failGemini`
(`timeout | error | rate_limit | quota | auth`). These drive the degradation tests.

## Explicitly NOT tested (no credentials in this environment)

These are exercised by the Preflight + test-email procedure in `docs/ACTIVATION.md` and
are **not** claimed as verified:

* Live Google OAuth consent and token exchange
* A real Gmail `messages.send` to a real mailbox
* Real Pub/Sub push delivery
* A real billed Grok or Gemini completion
* Real Telegram Bot API delivery and button callbacks
* A real DNS/TLS production deployment

No live email has been sent and no report has been delivered to a real Telegram chat by
this build.
