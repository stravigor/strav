# Framework gap analysis — Lead Qualification SaaS → ERP

**Date**: 2026-05-02
**Trigger**: Scoping a Lead Qualification SaaS (AI spam filter, lead scoring, basic CRM with import/export to other CRMs) that will eventually fold into an ERP. Goal: decide which capabilities should land in the framework now versus stay at the application level.
**Decision**: Implement Option C (audit + transit + signal/webhook) as a coordinated set.

## What the framework already provides

| Capability | Package(s) | Notes |
|---|---|---|
| AI text classification, structured output, tool use, streaming | `@strav/brain` | Multi-provider (Anthropic, OpenAI, Gemini, DeepSeek) raw-fetch, no SDKs. `brain.classify()` exists. |
| Vector retrieval / RAG | `@strav/rag` | pgvector + in-memory drivers, chunking strategies, `retrievable()` ORM mixin. |
| Workflow orchestration | `@strav/workflow` | Sequential, parallel, conditional, looping; saga compensation. |
| State machines (lead lifecycle) | `@strav/machine` | `defineMachine()` + `stateful()` ORM mixin auto-persists. |
| Full-text search (fuzzy contact lookup) | `@strav/search` | Meilisearch / Typesense / Algolia / SQLite-FTS5 / pg_trgm; `searchable()` ORM mixin. |
| Email — outbound + **inbound** parsing | `@strav/signal/mail` | SMTP / Resend / SendGrid / Mailgun / Alibaba / Log; Postmark + Mailgun inbound webhooks; IMAP polling. |
| Notifications (multi-channel) | `@strav/signal/notification` | Email, database, webhook, Discord. Now also WhatsApp / Messenger / LINE via the new messaging module. |
| Instant messaging | `@strav/signal/messaging` | WhatsApp Cloud API, Messenger, LINE — outbound + inbound webhook parsers. |
| Real-time + streaming | `@strav/signal/broadcast`, `@strav/signal/sse` | WebSocket channels and SSE for progress / live feeds. |
| Background jobs + scheduler | `@strav/queue` | Postgres-backed queue + cron-style scheduler. |
| Rate limiting | `@strav/http` | Pluggable store, per-route middleware. |
| Encryption (AES-256-GCM with rotation) | `@strav/kernel/encryption` | Used for at-rest secrets. |
| Multi-tenant schemas | `@strav/database` | `database/schemas/{public,tenants}/`, per-domain migrations. |
| Identity | `@strav/auth`, `@strav/oauth2`, `@strav/social` | JWT, OAuth2 server, social login. |
| Billing the SaaS itself | `@strav/stripe` | Subscriptions, invoices, webhooks, `billable()` mixin. |
| Test infrastructure | `@strav/testing`, `@strav/faker` | Auto-rolled-back tx per test, factories, fakers. |
| Feature flags | `@strav/flag` | Per-user / per-team scoped flags. |

## Stays at the application level

These are too domain-shaped or vendor-specific to generalize:

- **CRM data model** — `Lead`, `Contact`, `Organization`, `Deal`, `Pipeline`, `Activity`. Built in the app on `@strav/database` ORM.
- **Spam classifier prompts and lead-scoring rules** — domain logic. Built on `@strav/brain` + `@strav/machine`.
- **Pipeline / Kanban UI, dashboards, reports** — front-end on `@strav/view`.
- **Vendor-specific CRM connectors** (HubSpot, Salesforce, Pipedrive) — application-level integrations. May later be extracted if a generic OAuth2-API-client pattern emerges.

## Gaps — and where each one belongs

| # | Gap | Verdict | Where it should live |
|---|---|---|---|
| 1 | **Audit log / activity timeline** — who did what, when, with diffs; tamper-evident for regulated workflows | **Framework** — every ERP module needs it; retrofitting after domain models accumulate is expensive | New package: `@strav/audit` |
| 2 | **CSV / JSONL import-export pipeline** — streaming parse → validate → dedup → idempotent upsert → progress | **Framework** — domain-agnostic; reused by every app | New package: `@strav/transit` |
| 3 | **Outbound webhook delivery** — customer-registered endpoints, HMAC signing, exponential-backoff retry, DLQ, replay | **Framework** — `signal` already has inbound; outbound is the natural peer | New sub-module: `@strav/signal/webhook` |
| 4 | **Idempotency-Key middleware** — safe POST retries (esp. for bulk import + webhook ingest) | **Framework** | Add to `@strav/http` |
| 5 | **Job progress reporting** — `job.progress(0.42, 'msg')` → SSE for live UI | **Framework** | Add to `@strav/queue` |
| 6 | **Searchable encryption** — HMAC index column + encrypted payload (PII-safe email/phone queries) | **Framework** | Extend `@strav/kernel/encryption` |
| 7 | **External OAuth2-API client pattern** — generic token storage + refresh for HubSpot / Salesforce / etc. | **Maybe later** — extract from a real integration first | TBD |
| 8 | **Email / phone normalization helpers** | **Framework** — tiny | Add to `@strav/kernel/helpers` |

## Three implementation shapes considered

- **A — `@strav/audit` first.** Highest ERP leverage, blocks nothing else. Any domain code added after audit is in place gets logged automatically, no retrofit. Smallest surface to design.
- **B — `@strav/transit` first.** Highest day-one CRM value (customers expect to import their existing contact list on day one). Independent of audit.
- **C — All three (audit + transit + signal/webhook) as a coordinated set.** They share patterns (signed payloads, append-only log, retry/replay), so designing them together produces consistent surfaces. Gives the CRM build the import + outbound-webhook capabilities customers expect, plus puts the audit foundation in place before domain models accumulate.

## Decision: Option C

Coordinated build of all three. Reasoning:

1. **Pattern coherence**: HMAC signing logic, append-only persistence, queue-driven retries, and replay UX recur across all three. Designing them as a set lets us factor shared primitives (signature helpers, retry policy types) once.
2. **Day-one CRM unblockers**: bulk import (transit) and outbound webhooks (signal/webhook) are table-stakes for a CRM SaaS — customers expect them on launch. Building them framework-side keeps the application thin.
3. **ERP foundation**: audit log placed before the first domain model means every action is logged for free, no retrofit cost when ERP modules land.

## Intentionally deferred

- **#4 Idempotency-Key middleware** — small, but the trigger to add it is the first webhook-ingest endpoint. Add when it appears.
- **#5 Job progress reporting** — `@strav/transit` will model its own progress for now; promote to `@strav/queue` once a second consumer (e.g. search rebuild) needs it.
- **#6 Searchable encryption** — wait until the first PII-on-encrypted-column requirement appears (likely the lead email field).
- **#7 External OAuth2-API client** — extract once the second vendor integration goes in.
- **#8 Normalization helpers** — small enough to add inline first, then promote.

These are explicitly listed so the next person scoping work has a ready backlog and doesn't re-derive the analysis.

## What gets built under Option C

- **`@strav/audit`** — new package. `actor / subject / action / diff / metadata` events with HMAC hash chain, integrity verification, query API, database + memory drivers.
- **`@strav/transit`** — new package. Streaming CSV + JSONL import/export with validation, dedup, idempotent upsert, progress callbacks. Hand-rolled zero-dep CSV reader/writer.
- **`@strav/signal/webhook`** — new sub-module under `@strav/signal`. Customer-registered endpoint storage, event dispatch, HMAC-signed delivery (`X-Strav-Signature` header), exponential-backoff retry with jitter, dead-letter queue, replay.

Distinct from the existing `signal/notification/channels/webhook_channel.ts` (one-shot per-recipient delivery from `notify()`). The new module is for *event subscribers*: customers register endpoints, the app dispatches events, the framework guarantees delivery.

## References

- Capability inventory derived from package CLAUDE.md files (`packages/*/CLAUDE.md`) on 2026-05-02.
- Existing patterns reused: `MailManager` (single-driver), `NotificationManager` (channel map), `MessagingManager` (provider map), `flag/src/drivers/database_driver.ts` (`ensureTable()` pattern).
- Constant-time HMAC helpers already exist at `packages/signal/src/messaging/inbound/signature.ts` and will be the basis for the audit chain key derivation and webhook signing.
