# Sample daily report set (synthetic data only)

These seven PDFs were produced by the real report builder (`src/lib/report.ts`) from
**synthetic test prospects** on `@outreach-test.example.com` with `OUTREACH_MOCK=1`.

They contain **no real prospect data, no real email addresses and no real phone
numbers.** They exist to show the exact layout, field set and serial numbering an
operator receives through Telegram every 24 hours.

| File | Contents |
| --- | --- |
| `001_MAIN_PROSPECTS_*.pdf` | Business & professional segment — index table plus a full field block per prospect |
| `002_EVENT_PLANNERS_*.pdf` | Event & wedding planners — kept entirely separate from the main segment |
| `003_DAILY_ACTIVITY_*.pdf` | Messages drafted/sent/blocked, AI provider, quality scores, budget decisions |
| `004_REPLIES_FOLLOWUPS_*.pdf` | Inbound replies, classification, supplied phones, Gmail thread links |
| `005_APPOINTMENTS_*.pdf` | Consultation pipeline: proposed / awaiting / confirmed / rescheduled / cancelled |
| `006_DELIVERABILITY_*.pdf` | Bounce, complaint and opt-out rates, sending configuration, suppression list, failures |
| `007_EXECUTIVE_SUMMARY_*.pdf` | One-page operating state, serials issued, items needing attention |

Missing values are printed as `—`. They are never replaced with invented data.

There is **no CSV or spreadsheet output anywhere in this system.**

Regenerate at any time from the dashboard with **Generate report now** while in mock
mode.
