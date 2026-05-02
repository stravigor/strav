# Idempotency

Middleware that makes mutating endpoints safe to retry. Clients send an `Idempotency-Key` header; the framework caches the first response for that key so any retry returns the same response without re-running the handler.

Use this anywhere a network blip or a duplicate-submit could double-charge, double-import, or double-send: `POST /payments`, bulk imports, webhook ingest endpoints, "send invitation" actions, etc.

## Quick start

```typescript
import { idempotency } from '@strav/http'

router.post('/imports', idempotency(), async ctx => {
  const result = await processImport(await ctx.body())
  return ctx.json(result)
})
```

```bash
$ curl -X POST https://app.example/imports \
    -H "Idempotency-Key: import-2026-05-02-a8c1" \
    -H "Content-Type: application/json" \
    -d '{"file":"…"}'
```

A retry of that same request — same key, same body — returns the cached response with an `Idempotent-Replay: true` header. The handler does not run twice.

## Behavior

| Scenario | Result |
|---|---|
| Covered method, no `Idempotency-Key` | Pass through (handler runs as usual). Set `required: true` to reject instead. |
| Uncovered method (GET, HEAD, OPTIONS by default) | Pass through. |
| First request with key | Handler runs, response is captured under the key, response is returned with `Idempotent-Replay: true` on the **next** request only. |
| Retry — same key, **same** request fingerprint | Cached response replayed. Handler does NOT run. |
| Retry — same key, **different** body or path | `422 Unprocessable Entity`. Body / path mismatch usually means the client made a mistake, surfaced rather than silently returning wrong data. |
| Retry while the original is still in flight | `409 Conflict`. Tell the client to back off and retry. |
| Original handler returns `5xx` or throws | Key is **released**. Clients may retry. |
| Original handler returns `4xx` | Cached. Client errors are inherent to the request and should reproduce. |

The request fingerprint is `SHA-256(method + path + raw body)`. Header values do not participate — that's intentional, so retries with refreshed auth tokens or trace headers still match.

## Setup

### Default — in-memory store

```typescript
import { idempotency } from '@strav/http'

router.post('/imports', idempotency(), handler)
```

The default `MemoryIdempotencyStore` is fine for single-process deployments and for tests. Records expire lazily; nothing leaks beyond the configured TTL.

### Multi-process — database store

```typescript
import { idempotency, DatabaseIdempotencyStore } from '@strav/http'
import { Database } from '@strav/database'

const store = new DatabaseIdempotencyStore(Database.raw)
await store.ensureTable()

router.post('/imports', idempotency({ store }), handler)
```

Or apply the middleware globally to all mutating routes:

```typescript
const idem = idempotency({ store })
router.use(idem)
```

The Postgres store uses `INSERT … ON CONFLICT DO NOTHING RETURNING *` so concurrent attempts to reserve the same key are race-free — exactly one inserts; the rest see the existing row.

#### Cleanup

The database store does not auto-purge expired rows. Schedule a periodic sweep:

```typescript
import { Scheduler } from '@strav/queue'
import { Database } from '@strav/database'

Scheduler.task('idempotency:purge', async () => {
  await Database.raw`
    DELETE FROM "_strav_idempotency_keys" WHERE "expires_at" < NOW()
  `
}).hourly()
```

## Options

| Option | Default | Description |
|---|---|---|
| `ttl` | `24 * 60 * 60_000` (24 h) | How long a captured response remains replayable. |
| `header` | `'Idempotency-Key'` | Custom header name. |
| `methods` | `['POST','PUT','PATCH','DELETE']` | HTTP methods covered by the middleware. |
| `required` | `false` | When `true`, covered methods that omit the header are rejected with 400. |
| `store` | new `MemoryIdempotencyStore()` | Backing store. Implement `IdempotencyStore` for custom backends (Redis, etc.). |

## Schema

`_strav_idempotency_keys` (when using `DatabaseIdempotencyStore`):

| Column | Type | Notes |
|---|---|---|
| key | VARCHAR(255) PK | The client-supplied key. |
| fingerprint | TEXT | SHA-256 of `method\npath\nbody`. |
| response_status | INT NULL | `NULL` while the request is in flight. |
| response_headers | JSONB NULL | Captured headers map. |
| response_body | TEXT NULL | Base64-encoded body (binary-safe). |
| created_at | TIMESTAMPTZ DEFAULT NOW() | |
| expires_at | TIMESTAMPTZ | TTL bound. |

Index: `(expires_at)` for the cleanup sweep.

## Best practices

- **Pick a key the client controls** — `crypto.randomUUID()` per logical action works. Don't reuse keys across distinct user intents.
- **Combine with rate limiting**, not in place of it. Idempotency stops accidental duplicates; rate limiting stops abuse.
- **Tune TTL to your retry window**. The default 24 h covers most retry strategies. Bump it for offline-mobile clients that may retry days later.
- **Don't set `required: true` on user-facing routes**. Reserve it for service-to-service endpoints (webhook ingest, partner APIs) where the discipline is enforceable.
- **Watch for body size**. Captured bodies are stored verbatim — fine for JSON responses, costly for large file downloads. Apply the middleware selectively rather than globally if some endpoints return megabytes.

## Custom stores

Implement the `IdempotencyStore` interface — three methods:

```typescript
import type { IdempotencyStore, CapturedResponse } from '@strav/http'

class RedisIdempotencyStore implements IdempotencyStore {
  async reserve(key, fingerprint, ttlMs) {
    // SET NX EX with a payload of fingerprint, returning 'inserted' on success
    // GET on conflict, returning 'existing' with the parsed record
  }
  async complete(key, response: CapturedResponse) { /* SET (preserving TTL) */ }
  async release(key) { /* DEL */ }
}

router.post('/payments', idempotency({ store: new RedisIdempotencyStore() }), handler)
```

The race-free `reserve` is the only subtle method: the inserted-vs-existing decision must be atomic.

## Testing

```typescript
import { idempotency, MemoryIdempotencyStore } from '@strav/http'

const store = new MemoryIdempotencyStore()
const mw = idempotency({ store })

// In your test, reuse `store` across two `run(mw, ctx, handler)` calls and
// assert the second call's handler does not run.
```

The middleware works on plain `Context` and `Response` — no server boot required. See `packages/http/tests/idempotency.test.ts` for a full pattern.

## When NOT to use this

- **GET / HEAD / OPTIONS endpoints** — already idempotent by HTTP semantics.
- **Side-effect-free reads**. Caching is what HTTP `Cache-Control` is for.
- **Streamed responses** (SSE, file downloads). The current capture mechanism buffers the full body. For large responses, exempt those routes.
