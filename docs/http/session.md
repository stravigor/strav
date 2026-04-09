# Session

The session module provides a unified server-side session backed by a PostgreSQL database row and an HTTP-only cookie. A single `Session` class handles both anonymous visitors and authenticated users.

## Setup

### Using a service provider (recommended)

```typescript
import { SessionProvider } from '@strav/http'

app.use(new SessionProvider())
```

The `SessionProvider` registers `SessionManager` as a singleton and creates the `_stravigor_sessions` table automatically. It depends on the `database` provider.

Options:

| Option | Default | Description |
|--------|---------|-------------|
| `ensureTable` | `true` | Auto-create the sessions table |

### Manual setup

```typescript
import { SessionManager } from '@strav/http'

app.singleton(SessionManager)
app.resolve(SessionManager)
await SessionManager.ensureTable()
```

## Configuration

```typescript
// config/session.ts
import { env } from '@strav/kernel'

export default {
  cookie: 'stravigor_session', // cookie name
  lifetime: 120,               // minutes
  httpOnly: true,
  secure: env.bool('APP_SECURE', true),
  sameSite: 'lax' as const,
}
```

## session() middleware

The `session()` middleware runs on every request and handles the full lifecycle:

1. Reads the session cookie and loads the session from the database.
2. Creates a new anonymous session if absent or expired.
3. Ages flash data so previous-request flash values are readable.
4. Sets `ctx.get('session')` and `ctx.get('csrfToken')` for downstream handlers.
5. After the handler: saves dirty data to DB and refreshes the cookie (sliding expiration).

```typescript
import { router } from '@strav/http'
import { session } from '@strav/http'

// Apply globally
router.use(session())

// Or per group
router.group({ middleware: [session()] }, (r) => {
  r.get('/cart', showCart)
})
```

## Data bag

Store arbitrary key-value data in the session's JSONB column:

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

| Method | Description |
|--------|-------------|
| `get<T>(key, default?)` | Read a value (returns default if absent) |
| `set(key, value)` | Write a value (marks session dirty) |
| `has(key)` | Check if a key exists |
| `forget(key)` | Delete a key |
| `flush()` | Clear all data |
| `all()` | Return all user-facing data (excludes flash internals) |

Data is only persisted to the database when the session is dirty (something was modified). Read-only requests incur no DB writes.

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

Flash uses a two-bucket system (`_flash` and `_flash_old`). At the start of each request, the middleware calls `ageFlash()` which moves current flash to "old" (readable this request) and clears the current bucket. The old bucket is stripped before saving to the database, so stale flash data doesn't persist.

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

Persists session data to the database using an upsert. No-op if the session hasn't been modified. Called automatically by the `session()` middleware after each request.

### touch()

Updates only the `last_activity` timestamp without saving data. Called by the `auth()` middleware after authenticated requests.

### isExpired()

Checks whether the session has exceeded the configured lifetime based on `last_activity`.

### destroy()

Deletes the session row from the database and clears the cookie:

```typescript
const response = ctx.redirect('/login')
return Session.destroy(ctx, response)
```

## Garbage collection

Expired sessions remain in the database until cleaned up:

```typescript
import { SessionManager } from '@strav/http'

const deleted = await SessionManager.gc()
console.log(`Cleaned up ${deleted} expired sessions`)
```

Call this periodically via a cron job, CLI command, or timer.

## Middleware stacks

```
Anonymous:     session() → handler
Auth:          session() → auth() → handler
Auth + CSRF:   session() → auth() → csrf() → handler
Login page:    session() → guest('/dashboard') → handler
Login POST:    session() → csrf() → handler          (anonymous CSRF works!)
```

## Database table

**_stravigor_sessions**

| Column | Type | Notes |
|--------|------|-------|
| id | UUID | Primary key |
| user_id | VARCHAR | Nullable — null for anonymous visitors |
| csrf_token | VARCHAR(64) | Random hex, one per session |
| data | JSONB | Arbitrary key-value data |
| ip_address | VARCHAR(45) | From X-Forwarded-For |
| user_agent | TEXT | From User-Agent header |
| last_activity | TIMESTAMPTZ | Updated on each request |
| created_at | TIMESTAMPTZ | |
