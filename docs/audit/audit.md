# Audit

Append-only, tamper-evident audit log. Records `actor → action → subject` events with structured before/after diffs and free-form metadata; every row carries an HMAC chain hash so tampering can be detected by walking the log and recomputing.

Use it to answer "who changed what, when?" — for compliance, debugging, or just for the activity timeline on a CRM record. Built for the long tail: drop the provider in early, every domain action gets logged, no retrofit cost when the auditor (or the lawyer) shows up.

## Installation

```bash
bun add @strav/audit
```

## Setup

### Using a service provider (recommended)

```typescript
import { AuditProvider } from '@strav/audit'

app.use(new AuditProvider())
```

The `AuditProvider` registers `AuditManager` as a singleton, auto-creates the `_strav_audit_log` table, and depends on `config`, `database`, and `encryption` (the chain HMAC reuses the kernel's encryption key).

| Option | Default | Description |
|---|---|---|
| `ensureTable` | `true` | Auto-create the audit log table on boot. |

To skip auto-creation (e.g. you manage tables via migrations):

```typescript
app.use(new AuditProvider({ ensureTable: false }))
```

### Manual setup

```typescript
import AuditManager from '@strav/audit'

app.singleton(AuditManager)
app.resolve(AuditManager)
await AuditManager.ensureTable()
```

### Configuration

Create `config/audit.ts`:

```typescript
import { env } from '@strav/kernel'

export default {
  // 'database' (default) or 'memory' (tests).
  driver: env('AUDIT_DRIVER', 'database'),

  // Hash chain provides tamper evidence. Disable only for high-volume
  // non-compliance use cases where the guarantee is not needed.
  chain: env.bool('AUDIT_CHAIN', true),
}
```

The encryption manager must be configured (`APP_KEY` set) — the chain HMAC reuses its key.

## Logging events

The fluent builder is the primary API:

```typescript
import { audit } from '@strav/audit'

await audit
  .by({ type: 'user', id: user.id })   // who acted
  .on('lead', leadId)                  // what was acted on
  .action('qualified')                 // verb
  .diff(beforeLead, afterLead)         // structural diff (optional)
  .meta({ requestId, ip, source: 'web' })  // free-form context
  .log()
```

Subject and action are required. Actor is optional — system events log without one.

### Actor types

`audit.by(...)` accepts either an explicit `{ type, id }` literal or any object that implements `AuditActorLike`:

```typescript
class User extends BaseModel {
  // ... other model code

  auditActorType() { return 'user' }
  auditActorId() { return this.id }
}

await audit.by(currentUser).on('lead', leadId).action('updated').log()
```

For system events (no actor), drop `.by()`:

```typescript
await audit.on('lead', leadId).action('expired').log()
```

### Diffs

`.diff(before, after)` produces a structured `{ added, removed, changed }` shape with `{ before, after }` for each changed key:

```typescript
await audit
  .by(user)
  .on('lead', leadId)
  .action('updated')
  .diff(
    { name: 'Old', score: 10 },
    { name: 'New', score: 20, status: 'qualified' }
  )
  .log()
// → diff: {
//     added:   { status: 'qualified' },
//     changed: { name: { before: 'Old', after: 'New' },
//                score: { before: 10, after: 20 } }
//   }
```

`undefined → value` is recorded as `added` (not `changed`). `null` is a real value, distinct from `undefined`.

You can also pass a pre-built `AuditDiff`:

```typescript
await audit
  .by(user)
  .on('lead', leadId)
  .action('migrated')
  .diff({ added: { migrated: true } })
  .log()
```

### Direct write

When the fluent API is overkill (e.g. importing pre-built audit events from another system):

```typescript
import { audit } from '@strav/audit'

await audit.write({
  actorType: 'system',
  subjectType: 'lead',
  subjectId: '123',
  action: 'imported',
  metadata: { source: 'hubspot' },
})
```

## Querying

The `auditQuery` helper exposes a fluent reader API:

```typescript
import { auditQuery } from '@strav/audit'

// All events for a single subject
const history = await auditQuery
  .forSubject('lead', leadId)
  .since('-30d')
  .all()

// All events by an actor across subjects
const actions = await auditQuery
  .forActor('user', userId)
  .since('-7d')
  .actions(['updated', 'deleted'])
  .limit(100)
  .all()

// Range query — combine subject/actor filters
const recent = await auditQuery
  .range({ subjectType: 'lead' })
  .since('-1d')
  .all()
```

`since` / `until` accept a `Date`, an ISO string, or `-Nd|h|m|s` shorthand (e.g. `'-30d'`, `'-2h'`, `'-15m'`). Results come back in chronological order (id ASC).

## Redaction

`AuditManager.append()` automatically scrubs `metadata` and `diff` through `redact()` from `@strav/kernel` before the chain hash is computed. The deny-list catches common secret keys — `password`, `token`, `secret`, `api_key`, `authorization`, `cookie`, `set-cookie`, `x-api-key`, `x-auth-token`, plus camelCase variants — case-insensitive, exact-match. Matched values become the literal string `[REDACTED]`.

```typescript
await audit
  .by({ type: 'user', id: '1' })
  .on('account', '42')
  .action('login')
  .meta({ password: 'p4ss', userAgent: 'curl/7.0' })
  .log()

// Persisted metadata.password === '[REDACTED]'
// Persisted metadata.userAgent === 'curl/7.0'
```

Redaction also walks the diff structure — `added`, `removed`, and `changed.{before,after}` — so accidentally calling `.diff(beforeState, afterState)` with sensitive fields doesn't leak them either:

```typescript
await audit
  .by({ type: 'user', id: '1' })
  .on('account', '42')
  .action('updated')
  .diff(
    { name: 'A', api_key: 'old-key' },
    { name: 'B', api_key: 'new-key', token: 't' }
  )
  .log()

// Persisted diff:
//   changed.name = { before: 'A', after: 'B' }
//   changed.api_key = { before: '[REDACTED]', after: '[REDACTED]' }
//   added.token = '[REDACTED]'
```

Because `redact()` is deterministic — same input always produces the same output — the chain hash is stable across appends and `verifyChain()` runs. Tamper-evidence is preserved.

To extend the deny-list with app-specific names, call the kernel helper directly before passing data in:

```typescript
import { redact } from '@strav/kernel'

await audit
  .by(actor).on('order', orderId).action('created')
  .meta(redact(rawMeta, { extraKeys: ['internalCode'] }))
  .log()
```

See [`@strav/kernel` helpers — `redact()`](../kernel/helpers.md#redact--secret-redaction) for the full deny-list and option reference.

## Integrity verification

`verifyChain()` walks the log, recomputes each row's HMAC, and confirms each row's `prev_hash` matches the previous row's `hash`:

```typescript
import { audit } from '@strav/audit'

const result = await audit.verifyChain()
// → { ok: true,  checked: 12345 }
// → { ok: false, brokenAt: 4711, checked: 4711 }
```

The chain is broken if any row's stored hash doesn't recompute, or if two adjacent rows' linkage is wrong (someone deleted, swapped, or inserted rows).

Run it as a scheduled job or as an on-demand admin action:

```typescript
import { Scheduler } from '@strav/queue'

Scheduler.task('audit:verify', async () => {
  const result = await audit.verifyChain()
  if (!result.ok) {
    // page oncall — chain integrity is the canary for tampering
    await notify(secOps, new AuditTamperedNotification(result.brokenAt!))
  }
}).daily()
```

You can bound the walk to a range (e.g. for incremental verification):

```typescript
await audit.verifyChain({ from: lastVerifiedId + 1 })
```

## Common patterns

### Auto-log model updates

Wire it into your model's update path so every change becomes an audit event:

```typescript
class Lead extends BaseModel {
  async update(patch: Partial<this>, actor: User) {
    const before = { ...this }
    Object.assign(this, patch)
    await this.save()
    await audit
      .by(actor)
      .on('lead', this.id)
      .action('updated')
      .diff(before, this)
      .log()
  }
}
```

### Activity timeline on a record

```typescript
async function leadTimeline(leadId: string) {
  return auditQuery.forSubject('lead', leadId).since('-90d').all()
}
```

### What did this user do this week?

```typescript
async function weeklyReport(userId: string) {
  return auditQuery.forActor('user', userId).since('-7d').all()
}
```

### Importing legacy events

If you're backfilling from a legacy system, `chain: false` lets you bulk-insert without breaking the future chain. Re-enable chaining for new events going forward.

`AuditManager` refuses to boot with `chain: false` unless `app.env` is one of `local`, `development`, or `test` — in any other environment (including unset `app.env`, which defaults to `production`) it throws a `ConfigurationError`. The boot also emits a `console.warn` whenever chain is disabled, so the operator sees the loss of tamper-evidence in startup logs. Backfill scripts should run with `app.env=test` (or in a dedicated environment) and switch back to chained mode for the production cutover.

## Schema

`_strav_audit_log`:

| Column | Type | Notes |
|---|---|---|
| id | BIGSERIAL PK | Monotonic; chain walks forward by id ASC. |
| actor_type | VARCHAR(255) NULL | `'user'`, `'system'`, `'api_key'`, etc. |
| actor_id | VARCHAR(255) NULL | Nullable for system events. |
| subject_type | VARCHAR(255) | `'lead'`, `'deal'`, `'contact'`, etc. |
| subject_id | VARCHAR(255) | |
| action | VARCHAR(64) | Verb. |
| diff | JSONB | `{ added, removed, changed: { before, after } }`. |
| metadata | JSONB | Free-form context. |
| prev_hash | TEXT NULL | NULL on the first row. |
| hash | TEXT | HMAC-SHA256 in hex. |
| created_at | TIMESTAMPTZ DEFAULT NOW() | |

Indexes:

- `(subject_type, subject_id, id DESC)` — main subject-timeline query.
- `(actor_type, actor_id, id DESC) WHERE actor_type IS NOT NULL` — actor-history query.
- `(created_at DESC)` — global time scans.

## Hash chain — what it gives you

Every row's `hash` is `HMAC-SHA256(prev_hash || canonical(row), key)`, where `key` is derived from `APP_KEY` via the kernel's `EncryptionManager.sign`.

`canonicalize()` serializes the row as a tuple — `[actorType, actorId, subjectType, subjectId, action, diff, metadata, prev_hash]` — to avoid object-key-ordering ambiguity. Rebuilding the same hash requires the same key and the same serialized inputs in the same order.

What it detects:

- **Mutated rows** — changing any field on a logged row breaks `hash`.
- **Reordering** — swapping two rows breaks the `prev_hash` chain.
- **Deletion** — removing a row leaves a `prev_hash` mismatch on its successor.
- **Forged rows** — appending without the key produces an invalid `hash`.

What it doesn't detect:

- **Truncation of the tail** — if an attacker can mass-delete the last N rows, the chain still verifies up to the new tail. Mitigate with periodic snapshots: persist the latest hash to an external system (S3 with object-lock, an offsite database, your monitoring).
- **Key compromise** — anyone with `APP_KEY` can forge a chain. Treat the key like any other secret; rotate by appending past keys to `encryption.previousKeys` and writing new entries with the new key.

For most applications this is the right tradeoff. If you need stronger guarantees (Merkle proofs, blockchain anchoring), build on top — `verifyChain()` is the integrity primitive you'd plug into.

## Custom stores

Implement the `AuditStore` interface and call `AuditManager.useStore(...)` in bootstrap. The interface is small (insert + several read methods + walk + lastHash + reset). Useful for routing audit to a separate database, an OLAP store, or an external SIEM.

```typescript
import type { AuditStore } from '@strav/audit'
import { AuditManager } from '@strav/audit'

class S3AuditStore implements AuditStore {
  readonly name = 's3'
  // ... implementation
}

AuditManager.useStore(new S3AuditStore())
```

## Testing

Use `MemoryAuditDriver` to avoid the database:

```typescript
import { describe, beforeEach, test, expect } from 'bun:test'
import { EncryptionManager } from '@strav/kernel'
import AuditManager, { audit, MemoryAuditDriver } from '@strav/audit'

beforeEach(() => {
  EncryptionManager.useKey('test-app-key')
  AuditManager.useStore(new MemoryAuditDriver())
})

test('logs and queries', async () => {
  await audit.by({ type: 'user', id: 1 }).on('lead', '1').action('created').log()
  // ...
})
```

`EncryptionManager.useKey` initializes the HMAC key without going through `Configuration`. The memory driver matches the database driver's chain semantics so tests catch bugs the same way prod would.

## API reference

### `audit` helper

| Method | Description |
|---|---|
| `audit.by(actor)` | Start a fluent event with an actor. |
| `audit.on(type, id)` | Start a fluent event with a subject (system action). |
| `audit.write(event)` | Write a fully-formed event without the fluent builder. |
| `audit.verifyChain(opts?)` | Walk the chain and verify integrity. |

### `auditQuery` helper

| Method | Description |
|---|---|
| `auditQuery.forSubject(type, id)` | Events for a subject. |
| `auditQuery.forActor(type, id)` | Events by an actor. |
| `auditQuery.range(filter)` | Composite filter. |

Each returns a `PendingAuditQuery` with `.since(bound) / .until(bound) / .actions([...]) / .limit(n) / .all()`.

### Types

`AuditEvent`, `AuditDiff`, `AuditActor`, `AuditQueryOptions`, `AuditChainResult`, `AuditStore` — all exported from the package root.
