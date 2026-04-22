# Session

A unified server-side session backed by a pluggable **session store** and an HTTP-only cookie. A single `Session` class handles both anonymous visitors and authenticated users.

The storage backend is pluggable: `@strav/kernel` defines the `SessionStore` interface and `@strav/database` ships two implementations — `PostgresSessionStore` (default) and `RedisSessionStore`. Choose at provider registration time.

## Setup

### Using a service provider (recommended)

```typescript
import { SessionProvider } from '@strav/http'

// Postgres (default)
app.use(new SessionProvider())

// Redis
app.use(new RedisProvider())
app.use(new SessionProvider({ driver: 'redis' }))
```

`SessionProvider` registers `SessionManager` as a singleton, resolves the store for the configured driver, and plugs it in. It depends on `database` (and on `redis` when `driver: 'redis'`).

Options:

| Option         | Default       | Description                                                                            |
|----------------|---------------|----------------------------------------------------------------------------------------|
| `driver`       | `'postgres'`  | `'postgres'` or `'redis'` — selects the backing store                                  |
| `ensureSchema` | `true`        | For Postgres, auto-create `_strav_sessions`. No-op for Redis (uses native TTL).        |

### Manual setup

```typescript
import { SessionManager } from '@strav/http'
import { PostgresSessionStore } from '@strav/database'

app.singleton(SessionManager)
app.singleton(PostgresSessionStore)

app.resolve(SessionManager)
const store = app.resolve(PostgresSessionStore)
SessionManager.useStore(store)
await store.ensureSchema()
```

## Configuration

```typescript
// config/session.ts
import { env } from '@strav/kernel'

export default {
  driver: env('SESSION_DRIVER', 'postgres') as 'postgres' | 'redis',
  cookie: 'strav_session', // cookie name
  lifetime: 120,           // minutes
  httpOnly: true,
  secure: env.bool('APP_SECURE', true),
  sameSite: 'lax' as const,
}
```

The `driver` field is informational for `SessionManager.config` — the actual driver is chosen when you construct `SessionProvider`. Pass the same value to both so they stay in sync:

```typescript
const driver = config.get('session.driver') as 'postgres' | 'redis'
app.use(new SessionProvider({ driver }))
```

### Redis-backed sessions

See [`@strav/database` → Redis](../database/redis.md) for the Redis client setup. In short:

```bash
# .env
SESSION_DRIVER=redis
REDIS_URL=redis://localhost:6379
```

```typescript
import { RedisProvider } from '@strav/database'
import { SessionProvider } from '@strav/http'

app
  .use(new RedisProvider())
  .use(new SessionProvider({ driver: 'redis' }))
```

`RedisSessionStore` leans on Redis TTL (set from `session.lifetime`), so expired sessions are evicted automatically — `SessionManager.gc()` is a no-op for Redis.

## session() middleware

The `session()` middleware runs on every request and handles the full lifecycle:

1. Reads the session cookie and loads the session from the store.
2. Creates a new anonymous session if absent or expired.
3. Ages flash data so previous-request flash values are readable.
4. Sets `ctx.get('session')` and `ctx.get('csrfToken')` for downstream handlers.
5. After the handler: saves dirty data and refreshes the cookie (sliding expiration).

```typescript
import { router, session } from '@strav/http'

// Apply globally
router.use(session())

// Or per group
router.group({ middleware: [session()] }, (r) => {
  r.get('/cart', showCart)
})
```

## Data bag

Store arbitrary key-value data in the session:

```typescript
import type { Session } from '@strav/http'

router.post('/cart/add', async (ctx) => {
  const s = ctx.get<Session>('session')
  const { itemId } = await ctx.body<{ itemId: string }>()

  const cart = s.get<string[]>('cart', [])
  cart.push(itemId)
  s.set('cart', cart)

  return ctx.redirect('/cart')
})
```

### Methods

| Method                   | Description                                                |
|--------------------------|------------------------------------------------------------|
| `get<T>(key, default?)`  | Read a value (returns default if absent)                   |
| `set(key, value)`        | Write a value (marks session dirty)                        |
| `has(key)`               | Check if a key exists                                      |
| `forget(key)`            | Delete a key                                               |
| `flush()`                | Clear all data                                             |
| `all()`                  | Return all user-facing data (excludes flash internals)     |

Data is only persisted when the session is dirty. Read-only requests incur no store writes.

## Flash data

Flash data is available only on the **next** request — useful for success messages, error messages, and form validation feedback.

```typescript
// Request 1: set flash
s.flash('success', 'Item added to cart!')
s.flash('errors', { email: 'Invalid email address' })

// Request 2: read flash
s.getFlash('success')    // 'Item added to cart!'
s.hasFlash('success')    // true

// Request 3: gone
s.getFlash('success')    // undefined
```

### How it works

Flash uses a two-bucket system (`_flash` and `_flash_old`). At the start of each request, the middleware calls `ageFlash()` which moves current flash to "old" (readable this request) and clears the current bucket. The old bucket is stripped before saving, so stale flash data doesn't persist.

## Authentication

The session supports optional user association. See the [auth guide](./auth.md) for the full authentication flow.

```typescript
// Login — associate a user with the session
s.authenticate(user)      // accepts BaseModel instance or raw ID
await s.regenerate()      // new session ID (prevents fixation attacks)

// Check auth status
s.isAuthenticated         // true if userId is set
s.userId                  // string | null

// Logout — clear user association
s.clearUser()
// Or destroy the session entirely:
Session.destroy(ctx, ctx.redirect('/login'))
```

## Session lifecycle

### regenerate()

Creates a new session ID and CSRF token while preserving all data. Use after login to prevent session fixation attacks.

```typescript
await s.regenerate()
```

### save()

Persists session data via the configured store. No-op if the session hasn't been modified. Called automatically by the `session()` middleware after each request.

### touch()

Refreshes the session's activity marker without rewriting data (SQL `UPDATE` for Postgres, `EXPIRE` for Redis). Called by the `auth()` middleware after authenticated requests.

### isExpired()

Checks whether the session has exceeded the configured lifetime based on `last_activity`.

### destroy()

Deletes the session from the store and clears the cookie:

```typescript
const response = ctx.redirect('/login')
return Session.destroy(ctx, response)
```

## Garbage collection

For SQL-backed stores, expired sessions remain in the table until cleaned up:

```typescript
import { SessionManager } from '@strav/http'

const deleted = await SessionManager.gc()
console.log(`Cleaned up ${deleted} expired sessions`)
```

Call this periodically via a cron job, CLI command, or timer. For Redis-backed sessions this returns `0` — keys expire on their own via TTL.

## Pluggable stores

`SessionStore` is an interface in `@strav/kernel`:

```typescript
import type { SessionStore, SessionRecord } from '@strav/kernel'

interface SessionStore {
  ensureSchema?(): Promise<void>
  find(id: string): Promise<SessionRecord | null>
  save(record: SessionRecord): Promise<void>
  destroy(id: string): Promise<void>
  touch(id: string): Promise<void>
  gc(cutoff: Date): Promise<number>
}
```

Built-in implementations live in `@strav/database`:

| Store                  | Backend                    | `gc()`              | Notes                                   |
|------------------------|----------------------------|---------------------|------------------------------------------|
| `PostgresSessionStore` | `_strav_sessions` table    | deletes old rows    | Default. Uses `INSERT ... ON CONFLICT`. |
| `RedisSessionStore`    | `strav:session:<id>` keys  | no-op (native TTL)  | TTL synced from `session.lifetime`.     |

### Custom store

Implement `SessionStore` and plug it in before the session middleware runs:

```typescript
import type { SessionStore, SessionRecord } from '@strav/kernel'
import { SessionManager } from '@strav/http'

class MemcachedSessionStore implements SessionStore {
  async find(id: string): Promise<SessionRecord | null> { /* ... */ }
  async save(record: SessionRecord): Promise<void> { /* ... */ }
  async destroy(id: string): Promise<void> { /* ... */ }
  async touch(id: string): Promise<void> { /* ... */ }
  async gc(_cutoff: Date): Promise<number> { return 0 }
}

SessionManager.useStore(new MemcachedSessionStore())
```

## Middleware stacks

```
Anonymous:     session() → handler
Auth:          session() → auth() → handler
Auth + CSRF:   session() → auth() → csrf() → handler
Login page:    session() → guest('/dashboard') → handler
Login POST:    session() → csrf() → handler          (anonymous CSRF works!)
```

## Postgres table (driver: 'postgres')

**_strav_sessions**

| Column         | Type           | Notes                                  |
|----------------|----------------|----------------------------------------|
| id             | UUID           | Primary key                            |
| user_id        | VARCHAR(255)   | Nullable — null for anonymous visitors |
| csrf_token     | VARCHAR(64)    | Random hex, one per session            |
| data           | JSONB          | Arbitrary key-value data               |
| ip_address     | VARCHAR(45)    | From X-Forwarded-For                   |
| user_agent     | TEXT           | From User-Agent header                 |
| last_activity  | TIMESTAMPTZ    | Updated on save / touch                |
| created_at     | TIMESTAMPTZ    |                                        |

## Redis keys (driver: 'redis')

Each session is stored as a single JSON-serialized value under `strav:session:<uuid>` with a TTL equal to `session.lifetime * 60` seconds. `touch()` refreshes the TTL; no secondary indexes or cleanup tasks are needed.
