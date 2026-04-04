# Jina

The jina module (`@strav/jina`) provides headless authentication flows — registration, login, logout, password reset, email verification, two-factor authentication (TOTP), password confirmation, and profile updates. It handles routing, validation, rate limiting, tokens, and events so you only need to define how your User model works.

Jina is headless: it returns JSON responses from API endpoints. You bring your own frontend. Supports both session-based (cookie) and token-based (access token) authentication.

Built on top of the [auth](./auth.md) and [session](./session.md) modules from `@strav/core`.

## Installation

```bash
bun add @strav/jina
bun strav install jina
```

The `install` command copies three things into your project:

- `config/jina.ts` — feature flags, rate limits, token lifetimes.
- `actions/jina.ts` — the actions contract (how your User model works).
- `resources/views/emails/reset-password.strav` and `verify-email.strav` — email templates.

All files are yours to edit. If a file already exists, the command skips it (use `--force` to overwrite).

## Setup

### 1. Implement the actions contract

Edit `actions/jina.ts` and fill in the functions that tell Jina how your User model works:

```typescript
// actions/jina.ts
import { defineActions } from '@strav/jina'
import { encrypt } from '@strav/core/encryption'
import User from '../models/user'

export default defineActions<User>({
  async createUser(data) {
    return await User.create({
      name: data.name,
      email: data.email,
      password: await encrypt.hash(data.password),
    })
  },

  async findByEmail(email) {
    return await User.query().where('email', email).first()
  },

  async findById(id) {
    return await User.find(id)
  },

  passwordHashOf(user) {
    return user.password
  },

  emailOf(user) {
    return user.email
  },

  async updatePassword(user, newPassword) {
    user.password = await encrypt.hash(newPassword)
    await user.save()
  },
})
```

The `defineActions<TUser>()` helper is a typed identity function — it provides full autocompletion and type safety for all action methods.

> Note: Jina passes **raw passwords** to `createUser` and `updatePassword`. You are responsible for hashing them (typically with `encrypt.hash()`). This gives you full control over the hashing algorithm.

### 2. Register the provider

```typescript
import { JinaProvider } from '@strav/jina'
import actions from './actions/jina'

app.use(new JinaProvider(actions))
```

The `JinaProvider` depends on: `auth`, `session`, `encryption`, `mail`. It registers `JinaManager` as a singleton, validates that all required actions are present for enabled features, and registers routes automatically.

### 3. Configure

Edit `config/jina.ts`:

```typescript
import { env } from '@strav/core/helpers'

export default {
  features: [
    'registration',
    'login',
    'logout',
    'password-reset',
    // 'email-verification',
    // 'two-factor',
    // 'password-confirmation',
    // 'update-password',
    // 'update-profile',
  ],

  prefix: '',
  mode: 'session',

  rateLimit: {
    login:          { max: 5, window: 60 },
    register:       { max: 3, window: 60 },
    forgotPassword: { max: 3, window: 60 },
    verifyEmail:    { max: 3, window: 60 },
    twoFactor:      { max: 5, window: 60 },
  },

  passwords:     { expiration: 60 },
  verification:  { expiration: 60 },
  confirmation:  { timeout: 10_800 },

  twoFactor: {
    issuer: env('APP_NAME', 'Strav'),
    digits: 6,
    period: 30,
    recoveryCodes: 8,
  },
}
```

## Configuration reference

| Key | Default | Description |
|-----|---------|-------------|
| `features` | `['registration', 'login', 'logout', 'password-reset']` | Enabled features. Uncomment to add more. |
| `prefix` | `''` | Route prefix. Set `'/auth'` to mount at `/auth/login`, etc. |
| `mode` | `'session'` | `'session'` (cookie-based) or `'token'` (access tokens). |
| `routes.aliases.auth` | `'jina.auth'` | Route alias prefix for named routes. |
| `routes.subdomain` | `undefined` | Optional subdomain for routing (e.g., `'auth'` for auth.example.com). |
| `rateLimit.*` | varies | `{ max, window }` per flow. `window` is in seconds. |
| `passwords.expiration` | `60` | Password reset link lifetime in minutes. |
| `verification.expiration` | `60` | Email verification link lifetime in minutes. |
| `confirmation.timeout` | `10800` | Password confirmation timeout in seconds (default 3 hours). |
| `twoFactor.issuer` | `'Strav'` | TOTP issuer name shown in authenticator apps. |
| `twoFactor.digits` | `6` | TOTP code length. |
| `twoFactor.period` | `30` | TOTP code rotation period in seconds. |
| `twoFactor.recoveryCodes` | `8` | Number of recovery codes generated. |

## Feature flags

Each feature can be independently toggled in the `features` array. Only enabled features get their routes registered and their actions validated.

| Feature | Routes | Required actions |
|---------|--------|-----------------|
| `registration` | `POST /register` | `createUser`, `findByEmail` |
| `login` | `POST /login` | `findByEmail`, `passwordHashOf` |
| `logout` | `POST /logout` | — |
| `password-reset` | `POST /forgot-password`, `POST /reset-password` | `findByEmail`, `findById`, `emailOf`, `updatePassword` |
| `email-verification` | `POST /email/send`, `GET /email/verify/:token` | `isEmailVerified`, `markEmailVerified` |
| `two-factor` | `POST /two-factor/enable`, `POST /two-factor/confirm`, `DELETE /two-factor`, `POST /two-factor/challenge` | `twoFactorSecretOf`, `setTwoFactorSecret`, `recoveryCodesOf`, `setRecoveryCodes` |
| `password-confirmation` | `POST /confirm-password` | — |
| `update-password` | `PUT /password` | `updatePassword` |
| `update-profile` | `PUT /profile` | `updateProfile` |

## Actions contract

The `JinaActions<TUser>` interface defines how Jina interacts with your User model. Six methods are always required; the rest are required only when their feature is enabled.

### Required actions

| Method | Signature | Description |
|--------|-----------|-------------|
| `createUser` | `(data: RegistrationData) => Promise<TUser>` | Create and persist a new user. Password is raw. |
| `findByEmail` | `(email: string) => Promise<TUser \| null>` | Look up a user by email. Return `null` if not found. |
| `findById` | `(id: string \| number) => Promise<TUser \| null>` | Look up a user by primary key. |
| `passwordHashOf` | `(user: TUser) => string` | Return the stored password hash. |
| `emailOf` | `(user: TUser) => string` | Return the user's email address. |
| `updatePassword` | `(user: TUser, newPassword: string) => Promise<void>` | Persist a new password. Password is raw. |

### Optional actions

| Method | Feature | Signature | Description |
|--------|---------|-----------|-------------|
| `isEmailVerified` | `email-verification` | `(user: TUser) => boolean` | Whether the email is verified. |
| `markEmailVerified` | `email-verification` | `(user: TUser) => Promise<void>` | Mark the email as verified. |
| `twoFactorSecretOf` | `two-factor` | `(user: TUser) => string \| null` | Return the TOTP secret, or null. |
| `setTwoFactorSecret` | `two-factor` | `(user: TUser, secret: string \| null) => Promise<void>` | Persist or clear the TOTP secret. |
| `recoveryCodesOf` | `two-factor` | `(user: TUser) => string[]` | Return recovery codes. |
| `setRecoveryCodes` | `two-factor` | `(user: TUser, codes: string[]) => Promise<void>` | Persist recovery codes. |
| `updateProfile` | `update-profile` | `(user: TUser, data: Record<string, unknown>) => Promise<void>` | Update profile fields. |

## Routes

All routes are registered automatically by `JinaProvider`. They are prefixed with `config.prefix` (empty by default) and grouped under a configurable alias for easy route invocation.

| Method | Path | Middleware | Feature | Route Name | Description |
|--------|------|-----------|---------|-----------|-------------|
| POST | `/register` | `guest()`, rate limit | `registration` | `{alias}.register` | Create a new user |
| POST | `/login` | `guest()`, rate limit | `login` | `{alias}.login` | Authenticate |
| POST | `/logout` | `auth()` | `logout` | `{alias}.logout` | End session or discard token |
| POST | `/forgot-password` | `guest()`, rate limit | `password-reset` | `{alias}.forgot_password` | Send reset email |
| POST | `/reset-password` | `guest()` | `password-reset` | `{alias}.reset_password` | Reset password with token |
| POST | `/email/send` | `auth()`, rate limit | `email-verification` | `{alias}.send_verification` | Resend verification email |
| GET | `/email/verify/:token` | — | `email-verification` | `{alias}.verify_email` | Verify email |
| POST | `/two-factor/enable` | `auth()`, `confirmed()` | `two-factor` | `{alias}.enable_two_factor` | Generate TOTP secret |
| POST | `/two-factor/confirm` | `auth()` | `two-factor` | `{alias}.confirm_two_factor` | Confirm 2FA setup with code |
| DELETE | `/two-factor` | `auth()`, `confirmed()` | `two-factor` | `{alias}.disable_two_factor` | Disable 2FA |
| POST | `/two-factor/challenge` | rate limit | `two-factor` | `{alias}.two_factor_challenge` | Complete 2FA during login |
| POST | `/confirm-password` | `auth()` | `password-confirmation` | `{alias}.confirm_password` | Re-enter password |
| PUT | `/password` | `auth()` | `update-password` | `{alias}.update_password` | Change password |
| PUT | `/profile` | `auth()` | `update-profile` | `{alias}.update_profile` | Update profile |

Where `{alias}` defaults to `jina.auth` but can be customized in the configuration.

### Selective route registration

Filter which routes are registered using `only` or `except`:

```typescript
// Only register login and logout routes (skip all others)
JinaManager.routes(router, { only: ['login', 'logout'] })

// Register everything except profile update
JinaManager.routes(router, { except: ['update-profile'] })
```

When using `JinaProvider`, routes are registered for all enabled features. Use `only`/`except` when you need manual control — call `JinaManager.routes()` yourself instead.

### Route configuration

Configure route prefixes, aliases, and subdomains in your Jina config:

```typescript
// config/jina.ts
export default {
  prefix: '/auth',
  routes: {
    aliases: {
      auth: 'jina.auth'  // Default route alias
    },
    subdomain: 'api'     // Optional: mount on api.example.com
  },
  // Routes become: POST /auth/login, POST /auth/register, etc.
  // Named routes: jina.auth.login, jina.auth.register, etc.
}
```

#### Custom route aliases

Customize the route alias to match your application's naming:

```typescript
// config/jina.ts
export default {
  routes: {
    aliases: {
      auth: 'auth'  // Routes named: auth.login, auth.register, etc.
    }
  }
}

// Or for a multi-tenant app
export default {
  routes: {
    aliases: {
      auth: 'tenant.auth'  // Routes named: tenant.auth.login, etc.
    }
  }
}
```

#### Subdomain routing

Mount Jina routes on a specific subdomain:

```typescript
// config/jina.ts
export default {
  routes: {
    subdomain: 'auth'  // Routes accessible at auth.example.com
  }
}
```

### Using named routes

With route aliases configured, you can use Jina's authentication endpoints with the route helpers:

```typescript
import { route, routeUrl } from '@strav/http'

// Register a new user
const response = await route('jina.auth.register', {
  name: 'Alice Johnson',
  email: 'alice@example.com',
  password: 'secure_password',
  password_confirmation: 'secure_password'
})

// Login
await route('jina.auth.login', {
  email: 'alice@example.com',
  password: 'secure_password'
})

// Logout
await route('jina.auth.logout')

// Generate URLs for frontend links
const loginUrl = routeUrl('jina.auth.login')
const registerUrl = routeUrl('jina.auth.register')
const resetUrl = routeUrl('jina.auth.reset_password', {
  token: 'reset_token_here'
})

// Two-factor authentication
await route('jina.auth.enable_two_factor')
await route('jina.auth.confirm_two_factor', { code: '123456' })
await route('jina.auth.two_factor_challenge', { code: '789012' })

// Password management
await route('jina.auth.forgot_password', { email: 'alice@example.com' })
await route('jina.auth.update_password', {
  current_password: 'old_password',
  password: 'new_password',
  password_confirmation: 'new_password'
})

// Profile updates
await route('jina.auth.update_profile', {
  name: 'Alice Smith',
  timezone: 'America/New_York'
})
```

This eliminates hardcoded URLs and provides type-safe, refactorable route references throughout your application.

## Authentication flows

### Registration

**POST /register**

```json
{
  "name": "Alice",
  "email": "alice@example.com",
  "password": "password123",
  "password_confirmation": "password123"
}
```

Validates the input, checks for duplicate emails, creates the user via `actions.createUser`, and authenticates the session. Returns `201` with the user object.

In token mode, the response also includes a `token` and `accessToken`:

```json
{
  "user": { "id": 1, "name": "Alice", "email": "alice@example.com" },
  "token": "a1b2c3d4...",
  "accessToken": { "id": 1, "name": "registration", "..." : "..." }
}
```

If email verification is enabled, a verification email is sent automatically after registration.

### Login

**POST /login**

```json
{
  "email": "alice@example.com",
  "password": "password123"
}
```

Verifies credentials using `encrypt.verify()` against the hash from `actions.passwordHashOf()`. On success, authenticates the session and returns `200` with the user.

If the user has 2FA enabled, login returns a challenge response instead:

```json
{ "two_factor": true }
```

The user must then complete the [two-factor challenge](#two-factor-challenge) to finish logging in. The email is stored in the session as `_jina_2fa_email` during this interim step.

### Logout

**POST /logout**

In session mode, destroys the session (deletes the database row and clears the cookie). In token mode, returns a success message — the client should discard the token.

### Forgot password

**POST /forgot-password**

```json
{ "email": "alice@example.com" }
```

Always returns `{ "message": "If an account exists, a reset link has been sent." }` regardless of whether the email exists. This prevents email enumeration.

If the user exists, a signed token is created and emailed using the `jina.reset-password` template. The token contains `{ sub, typ: 'password-reset', email }` and expires after `passwords.expiration` minutes.

### Reset password

**POST /reset-password**

```json
{
  "token": "...",
  "password": "newpassword123",
  "password_confirmation": "newpassword123"
}
```

Verifies the signed token (type, expiration, email match), then calls `actions.updatePassword()` with the raw password.

### Email verification

Requires the `email-verification` feature and the `isEmailVerified` + `markEmailVerified` actions.

**POST /email/send** — Resend the verification email. Returns `200` if already verified or if the email was sent.

**GET /email/verify/:token** — Verify the email. The token is a signed, encrypted payload containing `{ sub, typ: 'email-verify', email }`. Validates the token, confirms the email still matches the user's current email, and calls `actions.markEmailVerified()`.

### Two-factor authentication

Requires the `two-factor` feature and the 2FA actions (`twoFactorSecretOf`, `setTwoFactorSecret`, `recoveryCodesOf`, `setRecoveryCodes`).

Jina implements TOTP (RFC 6238) with pure Bun crypto — no external dependencies.

#### Enable 2FA

**POST /two-factor/enable** (requires `auth()` + `confirmed()`)

Returns a TOTP secret and QR URI:

```json
{
  "secret": "JBSWY3DPEHPK3PXP",
  "qr_uri": "otpauth://totp/Strav:alice@example.com?secret=JBSWY3DPEHPK3PXP&issuer=Strav&digits=6&period=30"
}
```

The secret is stored in the session, **not** on the user yet. The user must scan the QR code with an authenticator app and confirm with a valid code.

#### Confirm 2FA setup

**POST /two-factor/confirm** (requires `auth()`)

```json
{ "code": "123456" }
```

Verifies the TOTP code against the pending secret in the session. On success, persists the secret to the user, generates recovery codes, and returns:

```json
{
  "message": "Two-factor authentication enabled.",
  "recovery_codes": ["a1b2c3d4", "e5f6g7h8", "..."]
}
```

> Store the recovery codes securely. They are the only way to recover access if the authenticator device is lost.

#### Two-factor challenge

**POST /two-factor/challenge**

During login, when the server returns `{ "two_factor": true }`, the client submits either a TOTP code or a recovery code:

```json
{ "code": "123456" }
```

or:

```json
{ "recovery_code": "a1b2c3d4" }
```

On success, completes the login (authenticates the session or returns an access token). Recovery codes are single-use — the used code is removed.

#### Disable 2FA

**DELETE /two-factor** (requires `auth()` + `confirmed()`)

Clears the TOTP secret and recovery codes.

### Password confirmation

Requires the `password-confirmation` feature.

**POST /confirm-password** (requires `auth()`)

```json
{ "password": "current-password" }
```

Verifies the current password and stores a `_jina_confirmed_at` timestamp in the session. This timestamp is checked by the `confirmed()` middleware. After `confirmation.timeout` seconds (default 3 hours), the confirmation expires and the user must re-enter their password.

### Update password

**PUT /password** (requires `auth()`)

```json
{
  "current_password": "oldpassword",
  "password": "newpassword123",
  "password_confirmation": "newpassword123"
}
```

Validates the current password, enforces minimum length (8 characters), and calls `actions.updatePassword()`.

### Update profile

**PUT /profile** (requires `auth()`)

```json
{ "name": "New Name" }
```

Passes the request body to `actions.updateProfile()`. You control which fields are accepted in your action.

## Middleware

Jina provides three middleware functions for protecting routes:

### verified()

Require the authenticated user to have a verified email. Returns `403` if not verified.

```typescript
import { auth } from '@strav/core/auth'
import { verified } from '@strav/jina'

router.group({ middleware: [auth(), verified()] }, r => {
  r.get('/dashboard', dashboardHandler)
})
```

### confirmed()

Require the user to have confirmed their password recently. Returns `423` (Locked) if the confirmation has expired or never happened.

```typescript
import { auth } from '@strav/core/auth'
import { confirmed } from '@strav/jina'

router.group({ middleware: [auth(), confirmed()] }, r => {
  r.delete('/account', deleteAccountHandler)
  r.put('/billing', updateBillingHandler)
})
```

The timeout is configured via `confirmation.timeout` in the Jina config (default 3 hours).

### twoFactorChallenge()

Require the user to have completed a 2FA challenge. Returns `403` if the user has 2FA enabled but a pending challenge exists in the session. If the user doesn't have 2FA enabled, the middleware passes through.

```typescript
import { auth } from '@strav/core/auth'
import { twoFactorChallenge } from '@strav/jina'

router.post('/transfer', auth(), twoFactorChallenge(), transferHandler)
```

## Events

Every auth flow emits an event via the core `Emitter`. Listen to events for side effects like logging, analytics, or notifications.

```typescript
import Emitter from '@strav/core/events'
import { JinaEvents } from '@strav/jina'

Emitter.on(JinaEvents.REGISTERED, async ({ user, ctx }) => {
  console.log(`New user: ${user.email}`)
})

Emitter.on(JinaEvents.LOGIN, async ({ user, ctx }) => {
  await logLoginAttempt(user, ctx.ip)
})
```

| Constant | Event string | Emitted when |
|----------|-------------|--------------|
| `REGISTERED` | `jina:registered` | User registers |
| `LOGIN` | `jina:login` | Login completes (after 2FA if applicable) |
| `LOGOUT` | `jina:logout` | User logs out |
| `PASSWORD_RESET` | `jina:password-reset` | Password is reset via token |
| `EMAIL_VERIFIED` | `jina:email-verified` | Email is verified |
| `TWO_FACTOR_ENABLED` | `jina:two-factor-enabled` | 2FA confirmed and activated |
| `TWO_FACTOR_DISABLED` | `jina:two-factor-disabled` | 2FA disabled |
| `PASSWORD_CONFIRMED` | `jina:password-confirmed` | Password re-entered for sensitive action |
| `PASSWORD_UPDATED` | `jina:password-updated` | Password changed |
| `PROFILE_UPDATED` | `jina:profile-updated` | Profile updated |

All event handlers receive a `{ user, ctx }` payload.

## jina helper

The `jina` helper provides utility functions for working with Jina's internals directly:

```typescript
import { jina } from '@strav/jina'

// Feature check
jina.hasFeature('two-factor')  // true

// Signed tokens (encrypted + tamper-proof)
const token = jina.signedToken({ sub: user.id, typ: 'custom' }, 60)
const payload = jina.verifyToken(token)

// Two-factor utilities
const { secret, qrUri } = jina.generateTwoFactorSecret(user)
const valid = await jina.verifyTwoFactorCode(secret, '123456')
const codes = jina.generateRecoveryCodes(8)
```

| Method | Description |
|--------|-------------|
| `hasFeature(feature)` | Check if a feature is enabled in the config. |
| `signedToken(data, minutes)` | Create an encrypted, signed token with an expiration. |
| `verifyToken(token)` | Verify and decode a token. Throws if expired or invalid. |
| `generateTwoFactorSecret(user)` | Generate a TOTP secret and QR URI for the user. |
| `verifyTwoFactorCode(secret, code)` | Verify a TOTP code against a base32 secret. |
| `generateRecoveryCodes(count?)` | Generate single-use recovery codes. |

## Email templates

Jina ships two `.strav` email templates:

- `resources/views/emails/reset-password.strav` — sent by the forgot password flow
- `resources/views/emails/verify-email.strav` — sent by the email verification flow

Both templates receive these variables:

| Variable | Description |
|----------|-------------|
| `resetUrl` / `verifyUrl` | The full URL with the signed token |
| `expiration` | Token lifetime in minutes |

Edit these templates to match your app's branding. They use the [view engine](./view.md) syntax: `{{ variable }}` for escaped output.

## Error handling

The module throws these error types:

- **`JinaError`** — base error (extends `StravError`)
- **`MissingActionError`** — a required action is missing for an enabled feature
- **`ValidationError`** — input validation failure

```typescript
import { JinaError, MissingActionError } from '@strav/jina'

try {
  JinaManager.validateActions()
} catch (error) {
  if (error instanceof MissingActionError) {
    console.error(error.message)
    // "Jina action 'isEmailVerified' is required for the 'email-verification' feature."
  }
}
```

`MissingActionError` is thrown at boot time if you enable a feature without providing its required actions. This is a startup-time guard — you'll see the error immediately.

## Auth modes

### Session mode (default)

Uses the [session module](./session.md) for cookie-based authentication. After login or registration, the session is authenticated and regenerated (new session ID to prevent fixation attacks). Logout destroys the session.

Requires `session()` middleware upstream of Jina's routes.

### Token mode

Uses [access tokens](./auth.md#access-tokens) for stateless authentication. After login or registration, an access token is created and returned in the response:

```json
{
  "user": { "..." : "..." },
  "token": "a1b2c3d4...",
  "accessToken": { "id": 1, "name": "login" }
}
```

The client stores the token and sends it in the `Authorization: Bearer <token>` header. Logout is a no-op on the server — the client discards the token.

> Note: 2FA and password confirmation use the session even in token mode, since they require server-side state during the multi-step flow.

## Security

- **Password hashing**: Uses `encrypt.verify()` (argon2id via `Bun.password`) for credential verification. Never stores or logs raw passwords.
- **Anti-enumeration**: The forgot password endpoint always returns success, regardless of whether the email exists.
- **Token safety**: Password reset and email verification tokens are encrypted with AES-256-GCM via `encrypt.seal()`. They are tamper-proof and opaque.
- **Token scoping**: Each token includes a `typ` field. A password-reset token cannot be used for email verification, and vice versa.
- **Email match check**: The email verification flow checks that the token's email still matches the user's current email, preventing reuse after an email change.
- **Session regeneration**: After login and registration, the session ID is regenerated to prevent session fixation attacks.
- **Rate limiting**: Every public-facing endpoint (login, register, forgot password, verify email, 2FA challenge) is rate-limited by default.
- **TOTP compliance**: Two-factor authentication follows RFC 6238 with HMAC-SHA1, a configurable time window, and ±1 period clock drift tolerance.
- **Recovery codes**: Single-use, 8-character hex codes. Used codes are removed immediately.
- **Password confirmation**: Sensitive operations (enabling/disabling 2FA) require the user to re-enter their password within a configurable timeout.

## Full example

```typescript
import { router } from '@strav/core/http'
import { session } from '@strav/core/session'
import { auth, csrf } from '@strav/core/auth'
import { JinaProvider, verified, confirmed } from '@strav/jina'
import actions from './actions/jina'

// Register the provider
app.use(new JinaProvider(actions))

// Jina auto-registers its routes (POST /login, POST /register, etc.)
// Add session middleware globally so Jina routes have access
router.use(session())

// Protected routes — require verified email
router.group({ middleware: [auth(), csrf(), verified()] }, r => {
  r.get('/dashboard', dashboardHandler)

  // Sensitive operations — require recent password confirmation
  r.group({ middleware: [confirmed()] }, r => {
    r.delete('/account', deleteAccountHandler)
  })
})
```
