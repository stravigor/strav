# Auth

The HTTP auth module provides database-backed authentication (sessions and access tokens), CSRF protection, and middleware for protecting routes. It integrates with `@strav/auth` for low-level authentication primitives like JWTs, TOTP, and tokens.

All session-based auth requires the `session()` middleware from the [session module](./session.md) to run first.

## Integration with @strav/auth

The HTTP auth module re-exports all `@strav/auth` primitives for convenience:

```typescript
import {
  // Database-backed auth (HTTP-specific)
  Auth, AccessToken, auth, csrf, guest,

  // Low-level primitives from @strav/auth
  signJWT, verifyJWT, createAccessToken as createJWTAccessToken,
  createSignedToken, createMagicLinkToken, generateSecret, verifyTotp,

  // HTTP bridge utilities
  createJWTCookie, verifyJWTCookie, createMagicLinkURL
} from '@strav/http/auth'
```

You can choose between:
- **Database-backed tokens**: AccessToken class for persistent authentication with revocation
- **Stateless JWT/signed tokens**: For distributed systems or temporary authentication

See the [Auth primitives guide](../auth/auth.md) for detailed usage of JWT, TOTP, tokens, and other low-level utilities.

## Setup

### Using a service provider (recommended)

```typescript
import { AuthProvider } from '@strav/http'
import User from './app/models/user'

app.use(new AuthProvider({ resolver: (id) => User.find(id) }))
```

The `AuthProvider` registers `Auth` as a singleton, sets the user resolver, and creates the `_stravigor_access_tokens` table automatically. It depends on the `database` provider.

Options:

| Option | Default | Description |
|--------|---------|-------------|
| `resolver` | — | Function to load a user by ID |
| `ensureTables` | `true` | Auto-create the access_tokens table |

### Manual setup

```typescript
import { Auth } from '@strav/http'
import User from './app/models/user'

app.singleton(Auth)
app.resolve(Auth)
Auth.useResolver((id) => User.find(id))
await Auth.ensureTables()
```

> The sessions table is managed by the [session module](./session.md) via `SessionManager.ensureTable()`.

## Configuration

```typescript
// config/auth.ts
export default {
  default: 'session',            // default guard

  token: {
    expiration: null,            // minutes, null = never expires
  },
}
```

Session configuration (cookie name, lifetime, etc.) lives in `config/session.ts` — see the [session guide](./session.md).

## Protecting routes

### auth() — require authentication

```typescript
import { session } from '@strav/http'
import { auth } from '@strav/http'

// Session auth (default guard) — requires session() upstream
router.group({ middleware: [session(), auth()] }, (r) => {
  r.get('/dashboard', (ctx) => {
    const user = ctx.get('user')    // loaded by the middleware
    return ctx.json(user)
  })
})

// Token auth (API) — no session needed
router.group({ prefix: '/api', middleware: [auth('token')] }, (r) => {
  r.get('/me', (ctx) => {
    const user = ctx.get('user')
    return ctx.json(user)
  })
})
```

The `auth()` middleware:
- For session guard: reads `ctx.get('session')` (set by upstream `session()` middleware), checks `session.isAuthenticated` and `session.isExpired()`.
- For token guard: reads the `Authorization: Bearer <token>` header and validates against the database.
- Loads the user via the registered resolver.
- Sets `ctx.get('user')` for downstream handlers.
- Returns `401` if authentication fails.

For token auth, it also sets `ctx.get('accessToken')` (the AccessTokenData record).

### csrf() — CSRF protection

```typescript
import { session } from '@strav/http'
import { csrf } from '@strav/http'

// Works with both anonymous and authenticated sessions
router.group({ middleware: [session(), csrf()] }, (r) => {
  r.get('/form', (ctx) => {
    const csrfToken = ctx.get('csrfToken')
    return ctx.html(`
      <form method="POST" action="/submit">
        <input type="hidden" name="_token" value="${csrfToken}">
        <button type="submit">Submit</button>
      </form>
    `)
  })

  r.post('/submit', (ctx) => {
    return ctx.json({ success: true })
  })
})
```

The `csrf()` middleware must be placed **after** `session()` (it needs the session).

On **GET/HEAD/OPTIONS** requests, it makes the CSRF token available via `ctx.get('csrfToken')`.

On **state-changing** requests (POST, PUT, PATCH, DELETE), it checks for a valid token in:
1. `X-CSRF-Token` header
2. `X-XSRF-Token` header
3. `_token` field in a JSON or form body

Returns `403` if the token is missing or doesn't match.

> Note: The `session()` middleware already sets `ctx.get('csrfToken')` on every request, so `csrf()` is only needed for the server-side validation on state-changing requests.

### guest() — reject authenticated users

```typescript
import { session } from '@strav/http'
import { guest } from '@strav/http'

// Redirect authenticated users to the dashboard
router.group({ middleware: [session(), guest('/dashboard')] }, (r) => {
  r.get('/login', showLoginPage)
})

// Or return 403 without redirect
router.group({ middleware: [session(), guest()] }, (r) => {
  r.get('/register', showRegisterPage)
})
```

## Sessions & Authentication

Sessions are managed by the [session module](./session.md). The auth module builds on top of it.

### Login

```typescript
import { Session } from '@strav/http'

router.post('/login', async (ctx) => {
  const { email, password } = await ctx.body<{ email: string; password: string }>()
  const user = await verifyCredentials(email, password) // your logic

  const s = ctx.get<Session>('session')
  s.authenticate(user)     // sets userId on the session
  await s.regenerate()     // new session ID (prevents fixation attacks)

  return ctx.redirect('/dashboard')
})
```

`session.authenticate()` accepts either a BaseModel instance or a raw user ID:

```typescript
s.authenticate(user)       // extracts PK from the model
s.authenticate(user.pid)   // raw string/number ID
```

### Logout

```typescript
import { Session } from '@strav/http'

router.post('/logout', async (ctx) => {
  const response = ctx.redirect('/login')
  return Session.destroy(ctx, response)
  // Deletes the DB row, clears the cookie
})
```

### Session garbage collection

Expired sessions remain in the database until cleaned up. Call `SessionManager.gc()` periodically (e.g., in a cron job or on a timer):

```typescript
import { SessionManager } from '@strav/http'

const deleted = await SessionManager.gc()
console.log(`Cleaned up ${deleted} expired sessions`)
```

## Access tokens (Database-backed)

HTTP access tokens are opaque random strings stored in the database. The plain token is returned once at creation and never stored — the database holds a SHA-256 hash. Even if the database is compromised, tokens cannot be recovered.

This is different from JWT access tokens (`@strav/auth`) which are stateless and self-contained.

### Creating a token

```typescript
import { AccessToken } from '@strav/http'

router.post('/api/tokens', auth(), async (ctx) => {
  const { name } = await ctx.body<{ name: string }>()
  const user = ctx.get('user')

  const { token, accessToken } = await AccessToken.create(user, name)
  // token        = 'a1b2c3d4...' (64-char hex, give to the client)
  // accessToken  = { id, userId, name, createdAt, ... }

  return ctx.json({ token, name: accessToken.name }, 201)
})
```

### Using a token

Clients send the token in the `Authorization` header:

```
Authorization: Bearer a1b2c3d4...
```

The `auth('token')` middleware handles validation automatically.

### Revoking tokens

```typescript
// Revoke a specific token
await AccessToken.revoke(tokenId)

// Revoke all tokens for a user
await AccessToken.revokeAllFor(user)
```

## Database tables

**_stravigor_sessions** — managed by the [session module](./session.md)

| Column | Type | Notes |
|--------|------|-------|
| id | UUID | Primary key (the session ID) |
| user_id | VARCHAR | Nullable — null for anonymous visitors |
| csrf_token | VARCHAR(64) | Random hex, one per session |
| data | JSONB | Arbitrary key-value data |
| ip_address | VARCHAR(45) | From X-Forwarded-For |
| user_agent | TEXT | From User-Agent header |
| last_activity | TIMESTAMPTZ | Updated on each request |
| created_at | TIMESTAMPTZ | |

**_stravigor_access_tokens** — managed by `Auth.ensureTables()`

| Column | Type | Notes |
|--------|------|-------|
| id | SERIAL | Primary key |
| user_id | VARCHAR | References the user's PK |
| name | VARCHAR | Human label ("mobile app", "CI") |
| token | VARCHAR(64) | SHA-256 hash, UNIQUE |
| last_used_at | TIMESTAMPTZ | Updated on each use |
| expires_at | TIMESTAMPTZ | Null = never expires |
| created_at | TIMESTAMPTZ | |

## HTTP Bridge Utilities

The `@strav/http/auth/bridge` module provides helpers for using `@strav/auth` primitives in HTTP contexts:

```typescript
import {
  createJWTCookie,
  verifyJWTCookie,
  createMagicLinkURL,
  extractBearerToken
} from '@strav/http/auth/bridge'

// Create JWT token and cookie header
const { token, cookieHeader } = await createJWTCookie(
  { userId: 123, role: 'admin' },
  'jwt-secret',
  {
    cookieName: 'auth-token',
    cookieOptions: { maxAge: 3600 }
  }
)

// Generate magic link for passwordless auth
const magicLink = createMagicLinkURL(
  'https://app.com/auth/magic',
  userId,
  { email: 'user@example.com', expiresInMinutes: 15 }
)

// Extract Bearer token from request
router.get('/protected', (ctx) => {
  const token = extractBearerToken(ctx)
  // Validate token...
})
```

## Full example

```typescript
import { router } from '@strav/http'
import { session, Session } from '@strav/http'
import { auth, csrf, guest, AccessToken } from '@strav/http'

// Global session middleware — every visitor gets a session
router.use(session())

// Public — only for guests
router.group({ middleware: [guest('/dashboard')] }, (r) => {
  r.get('/login', showLoginPage)
  r.post('/login', async (ctx) => {
    const user = await verifyCredentials(await ctx.body())
    const s = ctx.get<Session>('session')
    s.authenticate(user)
    await s.regenerate()
    return ctx.redirect('/dashboard')
  })
})

// Session-protected web routes
router.group({ middleware: [auth(), csrf()] }, (r) => {
  r.get('/dashboard', showDashboard)
  r.post('/logout', async (ctx) => {
    return Session.destroy(ctx, ctx.redirect('/login'))
  })
})

// Token-protected API routes (database-backed tokens)
router.group({ prefix: '/api', middleware: [auth('token')] }, (r) => {
  r.get('/me', (ctx) => ctx.json(ctx.get('user')))
})
```
