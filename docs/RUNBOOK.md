# Operational runbook

## Daily (≈5 minutes)

1. Read the 24-hour Telegram report (summary + CSV + XLSX).
2. Act on any 🟢 reply alert — **the system never auto-replies to a sales conversation.**
   Each one creates a pending row in `approvals` with a suggested next step.
3. Clear the **Needs review** tab: each row states exactly why it was blocked.
4. Top up the prospect pool if `Eligible` is below ~10.

## Adding prospects

Dashboard → *Import prospects* → JSON array. Every record must carry a public
`emailSourceUrl`, a `sourceUrl`, and a `qualificationReason`; roles are matched against
the relevant decision-maker / planner categories. Claims are only marked verified when
≥80% of the claim's distinctive terms actually appear in the supplied excerpt — an
operator cannot flag a claim verified by assertion.

```json
[{
  "fullName": "Rohan Mehta",
  "role": "Managing Director",
  "company": "Mehta Advisory LLP",
  "segment": "professional",
  "email": "rohan@mehtaadvisory.example",
  "emailSourceUrl": "https://mehtaadvisory.example/team/rohan-mehta",
  "sourceUrl": "https://mehtaadvisory.example/team/rohan-mehta",
  "website": "https://mehtaadvisory.example",
  "qualificationReason": "Managing Director of a Bengaluru advisory firm; client-facing senior professional.",
  "claims": [{
    "claimText": "Rohan Mehta is Managing Director at Mehta Advisory LLP in Bengaluru",
    "sourceUrl": "https://mehtaadvisory.example/team/rohan-mehta",
    "excerpt": "Rohan Mehta is Managing Director at Mehta Advisory LLP in Bengaluru, leading the corporate advisory practice."
  }]
}]
```

`segment: "event_planner"` for planners — they are stored, qualified, campaigned and reported entirely separately. The 80/20 split is applied as a planning ratio
when selecting from the eligible pool; it never promotes a weak prospect.

## Reply policy (documented, as required by section 11)

| Classification | Decided by | Automatic action | Operator action |
| --- | --- | --- | --- |
| `unsubscribe` | rules | permanent suppression, `UNSUBSCRIBED`, follow-ups cancelled | none |
| `complaint` | rules | permanent suppression, `UNSUBSCRIBED` | review source quality |
| `hard_bounce` | rules | permanent suppression, `BOUNCED` | review source quality |
| `soft_bounce` | rules | no state change, follow-ups cancelled | none |
| `decline` | rules | `DECLINED`, no further contact | none |
| `auto_reply` (OOO) | rules | follow-ups cancelled, no state change | none |
| `interested` / `consultation` / `pricing` | AI, human-confirmed | `INTERESTED`, Telegram alert with suggested next step | **reply personally from Gmail** |
| `ambiguous` | fallback | `AMBIGUOUS`, Telegram alert | classify and respond manually |

**No automated sales response is ever sent.** The only automated outbound messages are
the initial email and the single follow-up.

## Incidents

### Something is wrong — stop everything
Telegram **🛑 EMERGENCY STOP** (or the dashboard button). Outbound stops instantly;
reply recording, suppression and reporting continue. Nothing is deleted.

### Live sending refuses to start
Open the dashboard banner — it lists every blocker verbatim. Typical causes: business
phone not set/verified, Gmail not authorised, `ADMIN_PASSWORD`/`TOKEN_ENCRYPTION_KEY`
missing, emergency stop active.

### A message is stuck in `uncertain`
The send outcome was unknown. The system **will not blind-retry**. The next
`send_due_messages` pass queries Gmail's Sent mailbox for that exact recipient+subject;
if found it reconciles to `sent`, otherwise it retries once safely.

### Dead-letter jobs > 0
Dashboard → the card lists the job types. Inspect `jobs.last_error` /
`jobs.error_category`. `permanent` means the job will never be retried — fix the cause,
then re-enqueue by letting the recurring schedule fire again.

### Telegram is down
Nothing is lost. Notifications stay in the outbox and flush with exponential backoff.
Rows that exhaust 8 attempts become `dead` and appear on the dashboard.

### Gmail authorisation expired
Telegram shows "Gmail authorization failure — sending paused" and sending blocks.
Dashboard → **Connect Gmail**. (In OAuth *Testing* status this happens every 7 days —
see `docs/SETUP_GMAIL.md`.)

### AI paused on spend
Expected behaviour at the ceiling. Raise `aiDailyCapUsd` / `aiMonthlyCapUsd` or top up,
then **Resume AI**. Drafting continues meanwhile with the neutral approved template.

### Suppression lookup failing
Sending refuses with a `DependencyJobError` and a critical alert fires. This is correct —
fix the database before anything else. **Never bypass it.**

## Sending volume

Volume is **not** a fixed number. The adaptive controller recomputes it every 6 hours
from a 14-day delivery-health window and records each decision in `budget_decisions`
(visible on the dashboard) with its reason and binding constraint.

To change its bounds, use `POST /api/admin/actions` → `update_settings`:

| Setting | Meaning |
| --- | --- |
| `budgetFloor` | conservative starting volume (default 5) |
| `budgetCeiling` | hard cap the controller may never exceed (default 40) |
| `providerDailyLimit` | **the limit you verified for your own Gmail account** — the system does not assert an official Google figure |
| `budgetGrowthPct` | growth step, applied at most once per 24h on clean metrics |

The effective limit is always the strictest of the three. Press **📈 Recompute send
budget** to force an evaluation.

### Appointments

Consultation state is derived only from the prospect's own words and the matched excerpt
is stored as evidence. `proposed`, `awaiting_confirmation`, `confirmed`, `rescheduled`
and `cancelled` are distinct; a meeting is never marked confirmed, and a date is never
invented, without an explicit statement.

## Monitoring

`GET /api/health` returns per-dependency status (database, send gate, Gmail, AI, AI
budget, Telegram, scheduler, jobs, reporting). It stays `200` while the database is
reachable — a missing integration pauses outbound email rather than taking the service
down. Point an uptime monitor at it and alert on `sendingPermitted:false` persisting
unexpectedly, or any `checks.*.ok === false`.
