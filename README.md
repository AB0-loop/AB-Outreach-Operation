# Aurum Bespoke — Autonomous Luxury Outreach System

A production-oriented B2B outreach and lead-management system for **Aurum Bespoke**
(premium bespoke tailoring, Bengaluru). It researches and qualifies prospects, grounds
every personalised sentence in stored evidence, writes and quality-reviews each email
individually, sends through the authorised Gmail API, monitors replies, stops
inappropriate follow-ups, and delivers a set of **serial-numbered PDF reports** through
Telegram every 24 hours.

It is configured once, verified with **Preflight**, started with one **Launch**, and
then runs without routine manual intervention.

---

## 1. Operating principle

The system is autonomous for routine processing and **never** autonomous about ignoring
opt-outs, inventing facts, bypassing provider limits, or spending beyond its budget.

Every unsafe condition **pauses**. Nothing ever falls back to a mode that sends anyway.

---

## 2. Architecture

| Component | Implementation |
| --- | --- |
| Application | Next.js 16 (App Router), single Node runtime. See [`docs/AUDIT.md`](docs/AUDIT.md) for the Quickly repository audit. |
| Database | PostgreSQL + Drizzle ORM — prospects, evidence, campaigns, messages, replies, suppressions, appointments, approvals, jobs, AI ledger, budget decisions, reports, audit log |
| Email | Gmail OAuth 2.0 + Gmail REST API (`gmail.send`, `gmail.readonly` only) |
| AI | **Grok primary → Gemini automatic failover**, per-provider budget ceilings ([`docs/SETUP_AI.md`](docs/SETUP_AI.md)) |
| Telegram | Bot API — alerts, inline control buttons, PDF delivery, durable retry outbox |
| Reports | **PDF only** (PDFKit). No CSV or spreadsheet output exists anywhere. |
| Background work | Durable `jobs` table + idempotency keys, in-process ticker or external cron |
| UI | Authenticated operations console at `/` |

This application is entirely separate from the aurumbespoke.com website: its own repo,
database, credentials, hosting and deployment. The website is referenced only as a brand
link inside emails and reports.

```
discover → DISCOVERED → VERIFIED → ELIGIBLE → QUEUED → SENT → REPLIED
                │           │          │         │        │
                └ REVIEW ◀──┴──────────┴─────────┘        ▼
                                           INTERESTED / DECLINED /
                                           UNSUBSCRIBED / BOUNCED /
                                           AMBIGUOUS / CLOSED
```

---

## 3. The controls that matter

| Control | Where |
| --- | --- |
| **Adaptive sending volume** — no hard-coded cap | `src/lib/budget.ts` |
| Grok → Gemini failover, budget-respecting | `src/lib/providers/ai.ts` |
| Evidence-grounded personalisation; fabrication rejected | `src/lib/validate.ts` |
| Luxury-voice quality gate; low-scoring drafts never sent | `src/lib/quality.ts` |
| Deterministic lead scoring | `scoreLead()` in `src/lib/quality.ts` |
| Global permanent suppression, fail-closed | `src/lib/suppression.ts` |
| Any reply cancels pending follow-ups | `processInbound()` |
| Appointment states never inferred | `detectAppointment()` |
| Human approval for substantive sales replies | `approvals` table |
| Separate event-planner segment, queue and report | `segment` + `generateReportSet()` |
| Durable 001–999 report serials | `src/lib/serial.ts` |
| Preflight + Launch gate | `src/lib/preflight.ts` |
| Emergency stop | `settings.emergencyStop` |

### Adaptive sending volume

The daily budget starts at `budgetFloor` (5) and moves **only** on measured evidence
over a 14-day window. The binding limit is always the strictest of: the
operator-verified provider recipient limit, the operator ceiling, and the health-derived
budget.

* **Raises** only when ≥10 sends of history, bounce <2%, complaints <0.1%, opt-outs <3%,
  average queue verification confidence ≥70 — and at most once per 24 hours.
* **Halves** at ≥5% bounces, ≥0.3% complaints or ≥5% opt-outs.
* **Pauses** at ≥10% bounces or ≥1% complaints.
* New messages and follow-ups share one budget.
* Every decision is persisted in `budget_decisions` with its reason and binding
  constraint, and shown on the dashboard.

No account rotation, no proxying, no evasion. If a genuine restriction is hit, the system
reduces or stops.

### Email quality

AI writes only the opening sentence, from one stored claim. Every mandatory element
(service description, website, verified phone, opt-out, signature) is rendered
deterministically. A draft must clear **both** factual validation and a quality score
(default ≥75) that penalises hype, flattery, manufactured urgency, mail-merge clichés,
name-stuffing, multiple CTAs and over-length copy. Failures are regenerated once, then
fall back to the neutral template — **never sent to meet a quota**.

### PDF reporting

Seven reports per cycle, each with its own durable serial:

```
001_MAIN_PROSPECTS_2026-10-14.pdf      005_APPOINTMENTS_2026-10-14.pdf
002_EVENT_PLANNERS_2026-10-14.pdf      006_DELIVERABILITY_2026-10-14.pdf
003_DAILY_ACTIVITY_2026-10-14.pdf      007_EXECUTIVE_SUMMARY_2026-10-14.pdf
004_REPLIES_FOLLOWUPS_2026-10-14.pdf
```

Serials run 001→999 from a single PostgreSQL counter row advanced by one atomic
`UPDATE … RETURNING`, so concurrent jobs and restarts cannot reuse one. On rollover the
cycle increments and is appended to the filename (`_c2`); `(serial, cycle)` is UNIQUE, so
an older report can never be silently overwritten. Samples (synthetic data only) are in
[`docs/samples/`](docs/samples/).

---

## 4. Quick start — works with no credentials

With `OUTREACH_MOCK=1` all four external providers are deterministic in-memory fakes, so
the entire pipeline runs before any key exists.

```bash
cp .env.example .env     # set DATABASE_URL, ADMIN_PASSWORD, SESSION_SECRET,
                         # TOKEN_ENCRYPTION_KEY, OUTREACH_MOCK=1
npm install
npx drizzle-kit push
npm run test             # 37 acceptance tests
npm run build && npm start
```

Sign in at `/login` → set the business phone → **Run preflight** → import prospects →
**Run scheduler tick**.

---

## 5. Going live

1. [`docs/SETUP_GMAIL.md`](docs/SETUP_GMAIL.md) — OAuth client, scopes, push, sending limits
2. [`docs/SETUP_AI.md`](docs/SETUP_AI.md) — Grok + Gemini keys, real billing check, ceilings
3. [`docs/SETUP_TELEGRAM.md`](docs/SETUP_TELEGRAM.md) — bot, chat id, webhook secret, buttons
4. [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — hosting, DNS, backup and restore
5. [`docs/SECURITY_PRIVACY.md`](docs/SECURITY_PRIVACY.md) — DPDP Act 2023, retention, redaction
6. [`docs/RUNBOOK.md`](docs/RUNBOOK.md) — daily operation and incidents
7. [`docs/ACTIVATION.md`](docs/ACTIVATION.md) — **the exact steps to switch on production sending**

---

## 6. Repository map

```
src/db/schema.ts        full PostgreSQL schema
src/lib/
  env settings state    configuration, lifecycle state machine
  suppression           global, permanent, fail-closed
  eligibility           pre-send gate
  discovery             robots-respecting ingestion, evidence, lead scoring
  compose validate      evidence-grounded drafting + rejection rules
  quality               luxury-voice scoring + lead scoring
  classify              deterministic stop rules, appointments, then AI
  budget                adaptive sending controller
  serial pdf report     durable serials + PDF-only report set
  preflight             dependency verification before Launch
  notify time log crypto audit
  providers/            ai (grok+gemini) · gmail · telegram · mock
  jobs/                 queue · handlers · runner
src/app/                dashboard, login, API routes
tests/acceptance.test.ts  37 tests
docs/                   audit, setup, runbook, activation, samples
```

---

## 7. Tests

`npm run test` — 37 tests, mocked providers, synthetic
`@outreach-test.example.com` recipients only. Mapping to the specification is in
[`docs/TESTING.md`](docs/TESTING.md). Live-credential tests are listed there as
explicitly unverified.
