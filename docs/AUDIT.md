# Repository audit — `AbdelftahZowail/Quickly`

Audited before adoption, as required by section 3 of the specification.

## What Quickly actually is

| Item | Finding |
| --- | --- |
| Description | Open-source self-hosted cold email platform ("open-source clone of Instantly") |
| Stack | Python / FastAPI backend, React (Vite) frontend, PostgreSQL, Caddy reverse proxy |
| License | MIT — permits forking, modification and commercial self-hosting |
| Sending | Gmail / Microsoft 365 OAuth2 APIs (not shared SMTP) |
| Features claimed | Multi-inbox sequencing, AI reply classification, campaign analytics, 90+ REST endpoints, n8n node, webhooks, MCP |
| Deployment | `docker compose up -d`, image `azowail/quickly:<tag>`, also tagged `latest` |
| Activity | ~28 stars, 10 forks, latest release v2.3.1; commit activity had gone quiet for months at the time of audit |

## Requirement-by-requirement assessment

| Requirement from the spec | Quickly | Decision |
| --- | --- | --- |
| Gmail OAuth API sending, threading, reply capture | Present and sound in concept | **Retained as a design pattern** — reimplemented with least-privilege scopes (`gmail.send`, `gmail.readonly` only) |
| AI reply classification | Present, but AI-first | **Replaced** — deterministic stop rules run first and can never be overridden by a model |
| Multi-inbox rotation | Present | **Deliberately removed.** Section 10 forbids inbox rotation to evade provider limits. A single authorized sender only. |
| Volume-oriented sequencing | Present | **Replaced** by a hard 5/day ceiling, one follow-up, four-business-day gap |
| Evidence-grounded personalization + fabrication rejection | Absent | **Built new** (`src/lib/validate.ts`, `src/lib/compose.ts`) |
| Global suppression + fail-closed eligibility gate | Partial (per-campaign unsubscribe) | **Built new** (`src/lib/suppression.ts`, `src/lib/eligibility.ts`) — global, permanent, fail-closed |
| Mandatory content gate (verified phone, website, opt-out) | Absent | **Built new** — live sending is impossible until the phone is configured and validated |
| AI cost ceiling, usage ledger, auto-suspension | Absent | **Built new** (`src/lib/providers/grok.ts`) |
| Telegram control surface + CSV/XLSX daily reports | Absent | **Built new** (`src/lib/notify.ts`, `src/lib/report.ts`) |
| Dependency pinning | `azowail/quickly:latest` is a mutable tag | **Rejected.** All dependencies here are pinned to exact versions in `package.json`. |

## Conclusion

Quickly is a legitimate, MIT-licensed project and its core architectural choice —
**send through the provider's own OAuth API rather than shared SMTP** — is correct and
has been retained. However it is designed for *volume* cold email across rotated
inboxes, which is the opposite of this specification's requirement set (lead quality,
factual grounding, hard ceilings, brand protection, deterministic stop rules).

Adopting the Python/FastAPI/React/Caddy stack would also have meant running three
runtimes to obtain features that then had to be largely disabled or rewritten, and its
published deployment depends on a mutable `latest` image tag.

**Decision: adopt the proven concepts, not the codebase.** This repository implements the
smallest safe system that satisfies every mandatory control, in a single Next.js +
PostgreSQL runtime with pinned dependencies. Each replaced component and the reason is
listed in the table above. No Quickly source code is vendored, so no license obligations
beyond attribution of the idea arise; the MIT notice is reproduced here for completeness.
