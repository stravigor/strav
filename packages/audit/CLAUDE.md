# @strav/audit

Append-only, tamper-evident audit log. Records `actor → action → subject` events with structured before/after diffs and free-form metadata; every row carries an HMAC chain hash so tampering can be detected by walking the log and recomputing.

## Dependencies
- @strav/kernel (peer) — uses `EncryptionManager.sign` for the chain HMAC
- @strav/database (peer) — only for the database driver

## Commands
- bun test
- bun run typecheck

## Architecture
- src/audit_manager.ts — singleton hub; resolves the active store; computes chain hashes via `hashFor()` + `canonicalize()`
- src/audit_provider.ts — ServiceProvider; depends on config + database + encryption; calls `ensureTable()` on boot
- src/helpers.ts — `audit` fluent builder (`audit.by(...).on(...).action(...).diff(before, after).meta(...).log()`)
- src/queries.ts — `auditQuery` fluent reader (`forSubject` / `forActor` / `range`); `resolveTimeBound` accepts `Date`, ISO string, or `-Nd|h|m|s` shorthand
- src/integrity.ts — `verifyChain()`; walks the store and recomputes hashes
- src/diff.ts — `diff(before, after)` produces `{ added, removed, changed: { before, after } }`
- src/drivers/database_driver.ts — Postgres `_strav_audit_log` table; BIGSERIAL ids for monotonic ordering
- src/drivers/memory_driver.ts — in-memory store for tests

## Schema
`_strav_audit_log`:
- id (BIGSERIAL PK), actor_type / actor_id (nullable, for system events), subject_type / subject_id, action, diff (JSONB), metadata (JSONB), prev_hash (TEXT), hash (TEXT), created_at (TIMESTAMPTZ)
- Indexes: `(subject_type, subject_id, id DESC)`, `(actor_type, actor_id, id DESC) WHERE actor_type IS NOT NULL`, `(created_at DESC)`

## Conventions
- Hash chain is computed over a tuple form to avoid object-key-ordering ambiguity. See `canonicalize()` in audit_manager.ts.
- Stores must enforce monotonic `id` ordering; chain verification walks `id ASC`.
- `chain: false` in config disables the HMAC for high-volume non-compliance use cases (the row still inserts, just without a hash).
- Subject and actor IDs are stored as VARCHAR(255). Pass numbers — the helper coerces via `String(...)`.
- `audit.by(...)` accepts `{ type, id }` literals or any object exposing `auditActorType()` / `auditActorId()`.
- `metadata` and `diff` are auto-scrubbed via `redact()` from `@strav/kernel` inside `AuditManager.append()`. Sensitive keys (`password`, `token`, `secret`, `api_key`, `authorization`, `cookie`, etc., case-insensitive) get their values replaced with `[REDACTED]` BEFORE the chain hash is computed, so `verifyChain()` recomputes identical hashes and integrity is preserved. The redactor is deterministic — same input always produces the same output, which is what the chain depends on.

## Testing
- Use `MemoryAuditDriver` directly via `AuditManager.useStore(new MemoryAuditDriver())` to avoid the database. Encryption must still be initialized — call `EncryptionManager.useKey('test-key')` in a `beforeEach`.
- `verifyChain()` is the integrity primitive — log a sequence of events, mutate one row in the store, verify it returns `ok: false` with the broken id.
