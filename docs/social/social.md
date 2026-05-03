# Social

The social module (`@strav/social`) provides OAuth 2.0 social authentication with a fluent, driver-based API. Users click "Sign in with Google" (or GitHub, Discord, etc.), get redirected to the provider, and come back with a verified profile you can use to create or log in a user.

Built-in providers: **Google**, **GitHub**, **Discord**, **Facebook**, **LinkedIn**. Custom providers can be added via `extend()`.

Requires the `session()` middleware from the [session module](./session.md) for CSRF state verification — this is non-optional. The previously-available `provider.stateless()` opt-out has been removed because it silently disabled CSRF protection. If you have an access token from an out-of-band flow (e.g., a mobile client that ran its own OAuth dance), use [`userFromToken()`](#user-from-token) instead.

## Installation

```bash
bun add @strav/social
bun strav install social
```

The `install` command copies two files into your project:

- `config/social.ts` — provider credentials and the `userKey` setting.
- `database/schemas/social_account.ts` — the schema for the `social_account` table.

Both files are yours to edit. If a file already exists, the command skips it (use `--force` to overwrite).

## Setup

### 1. Register SocialManager

#### Using a service provider (recommended)

```typescript
import { SocialProvider } from '@strav/social'

app.use(new SocialProvider())
```

The `SocialProvider` registers `SocialManager` as a singleton. It depends on the `database` provider.

#### Manual setup

```typescript
import { SocialManager } from '@strav/social'

app.singleton(SocialManager)
app.resolve(SocialManager)
```

### 2. Configure providers

Edit `config/social.ts` and uncomment the providers you need:

```typescript
// config/social.ts
import { env } from '@strav/kernel'

export default {
  userKey: 'id',
  providers: {
    google: {
      clientId: env('GOOGLE_CLIENT_ID', ''),
      clientSecret: env('GOOGLE_CLIENT_SECRET', ''),
      redirectUrl: env('GOOGLE_REDIRECT_URL', 'http://localhost:3000/auth/google/callback'),
    },
    github: {
      clientId: env('GITHUB_CLIENT_ID', ''),
      clientSecret: env('GITHUB_CLIENT_SECRET', ''),
      redirectUrl: env('GITHUB_REDIRECT_URL', 'http://localhost:3000/auth/github/callback'),
    },
  },
}
```

The `userKey` option controls which field on your user table is used as the foreign key in `social_account`. It defaults to `'id'`, which produces a `user_id` FK column. If your user table uses a custom primary key (e.g. `uuid`), set `userKey: 'uuid'` and the FK column becomes `user_uuid`.

### 3. Run the migration

Generate and apply the migration for the `social_account` table:

```bash
bun strav generate:migration -m "add social accounts"
bun strav migrate
```

### 4. Add environment variables

```env
GOOGLE_CLIENT_ID=your-google-client-id
GOOGLE_CLIENT_SECRET=your-google-client-secret

GITHUB_CLIENT_ID=your-github-client-id
GITHUB_CLIENT_SECRET=your-github-client-secret
```

Only configure the providers you need.

## Basic usage

The flow has two steps: **redirect** (send the user to the provider) and **callback** (receive the user back).

```typescript
import { router } from '@strav/http'
import { session } from '@strav/http'
import { social } from '@strav/social'

router.group({ middleware: [session()] }, r => {
  // Step 1: Redirect to provider
  r.get('/auth/github', ctx => {
    return social.driver('github').redirect(ctx)
  })

  // Step 2: Handle callback
  r.get('/auth/github/callback', async ctx => {
    const githubUser = await social.driver('github').user(ctx)

    // githubUser.id            → "12345"
    // githubUser.name          → "John Doe"
    // githubUser.email         → "john@example.com"
    // githubUser.emailVerified → true
    // githubUser.avatar        → "https://avatars.githubusercontent.com/u/12345"
    // githubUser.nickname      → "johndoe"
    // githubUser.token         → "gho_xxxx..."

    // SECURITY: only match an existing user by email when the provider
    // has verified it. See the "Verified-email gate" section below.
    let user: User | null = null
    if (githubUser.email && githubUser.emailVerified) {
      user = await User.findBy('email', githubUser.email)
    }
    if (!user) {
      user = new User()
      user.merge({ name: githubUser.name, email: githubUser.email })
      await user.save()
    }

    // Link the social account (or update tokens if already linked).
    // Tokens are encrypted at rest by SocialAccount — see "Token storage".
    await social.findOrCreate('github', githubUser, user)

    const s = ctx.get<Session>('session')
    s.authenticate(user)
    await s.regenerate()

    return ctx.redirect('/dashboard')
  })
})
```

## SocialUser

Every provider returns a `SocialUser` with these fields:

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | Unique identifier from the provider |
| `name` | `string \| null` | Full name |
| `email` | `string \| null` | Email address |
| `emailVerified` | `boolean` | Whether the provider asserts the email has been verified by the user. **Callers MUST check this before matching an existing app user by email.** See [Verified-email gate](#verified-email-gate). |
| `avatar` | `string \| null` | Profile picture URL |
| `nickname` | `string \| null` | Username / handle |
| `token` | `string` | OAuth access token |
| `refreshToken` | `string \| null` | Refresh token (if provided) |
| `expiresIn` | `number \| null` | Token lifetime in seconds |
| `approvedScopes` | `string[]` | Scopes granted by the user |
| `raw` | `Record<string, unknown>` | Full raw response from the provider API |

## Fluent API

### Additional scopes

Merge extra scopes onto the provider's defaults:

```typescript
social.driver('github').scopes(['repo', 'gist']).redirect(ctx)
```

### Replace all scopes

Override the default scopes entirely:

```typescript
social.driver('google').setScopes(['openid', 'email']).redirect(ctx)
```

### Custom parameters

Pass additional query parameters to the authorization URL:

```typescript
social.driver('google')
  .with({ hd: 'example.com', prompt: 'consent' })
  .redirect(ctx)
```

### User from token

If you already have an access token from an out-of-band flow (e.g., a mobile app that ran its own OAuth dance), fetch the user profile directly without the redirect flow:

```typescript
const user = await social.driver('google').userFromToken(accessToken)
```

`userFromToken()` is the only stateless path in this module. It does not validate CSRF state because there is no redirect to defend — the caller is asserting they already obtained the token securely. The previously-available `provider.stateless()` opt-out for the redirect flow has been removed (it silently disabled CSRF protection); state is mandatory for `redirect()` + `user()`.

## Built-in providers

### Google

- Default scopes: `openid`, `email`, `profile`
- User fields: `sub` → id, `name` → name, `email` → email, `picture` → avatar
- `emailVerified`: from the OIDC `email_verified` claim (`false` if missing)
- Supports the `hd` parameter to restrict to a Google Workspace domain:

```typescript
social.driver('google').with({ hd: 'mycompany.com' }).redirect(ctx)
```

### GitHub

- Default scopes: `read:user`, `user:email`
- User fields: `id` → id, `login` → nickname, `name` → name, `avatar_url` → avatar
- `emailVerified`: `true` whenever an email is returned. GitHub only exposes verified addresses — the profile `email` must be a verified one and the `/user/emails` fallback filters on `verified === true`.
- Automatically fetches the primary verified email from `/user/emails` when the profile email is private

### Discord

- Default scopes: `identify`, `email`
- User fields: `id` → id, `username` → nickname, `global_name` → name, `email` → email
- `emailVerified`: from the `verified` field on `/users/@me` (`false` if missing)
- Avatar URL is computed from the user's ID and avatar hash, with a default fallback

To request guild information:

```typescript
social.driver('discord').scopes(['guilds']).redirect(ctx)
```

### Facebook

- Default scopes: `email`, `public_profile`
- User fields: `id` → id, `name` → name, `email` → email, `picture.data.url` → avatar
- `emailVerified`: `true` whenever an email is returned. Facebook's Graph API only exposes the user's verified primary address; an unverified address is omitted from the response.
- Uses Graph API v21.0

To request additional permissions:

```typescript
social.driver('facebook').scopes(['user_birthday', 'user_location']).redirect(ctx)
```

### LinkedIn

- Default scopes: `openid`, `profile`, `email`
- User fields: `sub` → id, `name` → name, `email` → email, `picture` → avatar
- `emailVerified`: from the OIDC `email_verified` claim (`false` if missing)
- Uses the OpenID Connect userinfo endpoint (`/v2/userinfo`)

To request posting permissions:

```typescript
social.driver('linkedin').scopes(['w_member_social']).redirect(ctx)
```

## Custom providers

Register a custom OAuth provider with `extend()`:

```typescript
import { AbstractProvider, social } from '@strav/social'
import type { SocialUser } from '@strav/social'

class SpotifyProvider extends AbstractProvider {
  readonly name = 'Spotify'

  protected getDefaultScopes() {
    return ['user-read-email', 'user-read-private']
  }

  protected getAuthUrl() {
    return 'https://accounts.spotify.com/authorize'
  }

  protected getTokenUrl() {
    return 'https://accounts.spotify.com/api/token'
  }

  protected async getUserByToken(token: string) {
    const res = await fetch('https://api.spotify.com/v1/me', {
      headers: { Authorization: `Bearer ${token}` },
    })
    if (!res.ok) throw new Error(`Spotify API error: ${res.status}`)
    return await res.json()
  }

  protected mapUserToObject(data: Record<string, unknown>): SocialUser {
    const images = data.images as Array<{ url: string }> | undefined
    return {
      id: data.id as string,
      name: (data.display_name as string) ?? null,
      email: (data.email as string) ?? null,
      // Spotify exposes verification on the user object — populate from
      // whatever claim your provider gives. Default to `false` if there
      // is no signal; never default to `true` for unknown providers.
      emailVerified: false,
      avatar: images?.[0]?.url ?? null,
      nickname: data.id as string,
      token: '',
      refreshToken: null,
      expiresIn: null,
      approvedScopes: [],
      raw: data,
    }
  }
}

// Register the provider
social.extend('spotify', config => new SpotifyProvider(config))
```

Then add it to your config:

```typescript
// config/social.ts
export default {
  providers: {
    spotify: {
      driver: 'spotify',
      clientId: Bun.env.SPOTIFY_CLIENT_ID,
      clientSecret: Bun.env.SPOTIFY_CLIENT_SECRET,
      redirectUrl: 'http://localhost:3000/auth/spotify/callback',
    },
  },
}
```

Use it like any built-in driver:

```typescript
social.driver('spotify').redirect(ctx)
const user = await social.driver('spotify').user(ctx)
```

## Driver aliases

Use the `driver` field to reuse a built-in provider with different credentials:

```typescript
// config/social.ts
export default {
  providers: {
    // Production Google
    google: {
      clientId: Bun.env.GOOGLE_CLIENT_ID,
      clientSecret: Bun.env.GOOGLE_CLIENT_SECRET,
      redirectUrl: 'https://myapp.com/auth/google/callback',
    },
    // Same Google provider, different OAuth app for admin
    'google-admin': {
      driver: 'google',
      clientId: Bun.env.GOOGLE_ADMIN_CLIENT_ID,
      clientSecret: Bun.env.GOOGLE_ADMIN_CLIENT_SECRET,
      redirectUrl: 'https://myapp.com/admin/auth/google/callback',
      scopes: ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/admin.directory.user.readonly'],
    },
  },
}
```

## Error handling

The module throws two error types:

- **`SocialError`** — OAuth flow errors (invalid state, missing code, user denied access)
- **`ExternalServiceError`** — HTTP errors from the provider API (token exchange failure, profile fetch failure)

```typescript
import { SocialError } from '@strav/social'

r.get('/auth/github/callback', async ctx => {
  try {
    const user = await social.driver('github').user(ctx)
    // ... handle success
  } catch (error) {
    if (error instanceof SocialError) {
      // User denied access or CSRF mismatch
      return ctx.redirect('/login?error=auth_failed')
    }
    throw error
  }
})
```

When the user denies authorization at the provider, the callback URL receives an `error` query parameter (e.g., `?error=access_denied`), which is surfaced as a `SocialError`.

## SocialAccount

The `SocialAccount` class provides static methods for managing the `social_account` database table. It stores the link between a provider account and a local user, along with OAuth tokens.

### findOrCreate

The recommended way to link a social account. If a record already exists for the provider + provider ID, it updates the tokens. Otherwise it creates a new row.

```typescript
import { social, SocialAccount } from '@strav/social'

const githubUser = await social.driver('github').user(ctx)
const { account, created } = await social.findOrCreate('github', githubUser, user)
// or equivalently:
const { account, created } = await SocialAccount.findOrCreate('github', githubUser, user)
```

`findOrCreate()` does NOT validate the email — the security check belongs at the call site (the place that matched `user` from `socialUser.email`). See [Verified-email gate](#verified-email-gate). Tokens passed in are encrypted at rest before insert; see [Token storage](#token-storage).

### Other methods

```typescript
// Find by provider + provider ID
const account = await SocialAccount.findByProvider('github', '12345')

// Find all social accounts for a user
const accounts = await SocialAccount.findByUser(user)

// Create a new link manually
const account = await SocialAccount.create({
  user,
  provider: 'github',
  providerId: '12345',
  token: 'gho_xxxx',
  refreshToken: null,
  expiresAt: null,
})

// Update tokens
await SocialAccount.updateTokens(account.id, newToken, newRefreshToken, newExpiresAt)

// Delete
await SocialAccount.delete(account.id)
await SocialAccount.deleteByUser(user)
```

### SocialAccountData

All methods return or accept a `SocialAccountData` object. `token` and `refreshToken` are returned in **plaintext** — the encrypt/decrypt round-trip happens inside `SocialAccount`. The database stores ciphertext.

| Field | Type | Description |
|-------|------|-------------|
| `id` | `number` | Auto-incrementing primary key |
| `userId` | `string \| number` | Foreign key to the user table |
| `provider` | `string` | Provider name (e.g. `'github'`) |
| `providerId` | `string` | User's ID from the provider |
| `token` | `string` | OAuth access token (decrypted on read) |
| `refreshToken` | `string \| null` | Refresh token (decrypted on read) |
| `expiresAt` | `Date \| null` | Token expiry |
| `createdAt` | `Date` | Row creation time |
| `updatedAt` | `Date` | Last update time |

## Security

### CSRF state

A random 64-character hex string is stored in the session before redirect and verified on callback. This is mandatory for `redirect()` + `user()` — the previous `provider.stateless()` opt-out was removed because it silently disabled CSRF protection. The state value is removed from the session after verification (single-use).

If you have an access token from an out-of-band flow (e.g., a mobile app that ran its own OAuth), use [`userFromToken()`](#user-from-token) — that method is intentionally stateless because there is no redirect to defend.

### Verified-email gate

`SocialUser.emailVerified` reflects the provider's own assertion that the user owns the email:

| Provider | Source of truth |
|----------|-----------------|
| Google / LinkedIn | OIDC `email_verified` claim |
| Discord | `verified` field on `/users/@me` |
| GitHub | `true` whenever an email is returned (only verified addresses are exposed) |
| Facebook | `true` whenever an email is returned (only verified addresses are exposed) |
| Custom providers | Populate from the provider's verification claim. Default to `false` when there is no signal — never `true` for unknown providers. |

**Callers MUST check `socialUser.emailVerified === true` before using `socialUser.email` to look up an existing application user.**

If you skip this check, an attacker who registers a provider account using a victim's email (and that provider permits unverified addresses) gets linked to the victim's account on first sign-in. `SocialAccount.findOrCreate()` does not enforce this check itself — it can't tell whether `user` was located by email match or supplied directly — so the contract lives at the call site.

```typescript
// CORRECT: only match by email when the provider has verified it
let user: User | null = null
if (socialUser.email && socialUser.emailVerified) {
  user = await User.findBy('email', socialUser.email)
}

// WRONG: blindly matching by email opens the takeover vector
const user = await User.findBy('email', socialUser.email) // ✗
```

### Token storage

`SocialAccount.create()` and `updateTokens()` encrypt both `token` and `refreshToken` via `EncryptionManager` before they hit the database; `hydrate()` decrypts them on read. Encrypted values are stored with an `enc:v1:` sentinel prefix so legacy plaintext rows (predating this change) can be returned unchanged by `hydrate()` and migrate to ciphertext on the next `updateTokens()` call.

Tests that exercise `SocialAccount.create()` or `updateTokens()` must initialize encryption first (e.g., `EncryptionManager.useKey('test-key')` in `beforeEach`).

### Audit hooks

`SocialAccount` mutations emit Emitter events for accountability. Wire them once at bootstrap to capture token swaps and account-link changes:

| Event | Payload | Fired by |
|-------|---------|----------|
| `social_account:linked` | `{ accountId, userId, provider, providerId }` | `create()` / first-time `findOrCreate()` |
| `social_account:tokens_updated` | `{ accountId, hasRefreshToken, expiresAt }` (raw token NOT included) | `updateTokens()` / repeat `findOrCreate()` |
| `social_account:unlinked` | `{ accountId }` | `delete()` |
| `social_account:unlinked_all` | `{ userId }` | `deleteByUser()` |

```typescript
import { Emitter } from '@strav/kernel'
import { audit } from '@strav/audit'

Emitter.on('social_account:tokens_updated', e => {
  audit
    .bySystem('social')
    .on('social_account', String(e.accountId))
    .action('tokens_updated')
    .meta({ hasRefreshToken: e.hasRefreshToken })
    .log()
})
```

### Token-endpoint authentication

`getAccessToken()` defaults to `client_secret_basic` — the client credentials are sent in an HTTP Basic `Authorization` header (RFC 6749 §2.3.1, MUST-support form). This keeps the client secret out of body-logging surfaces (proxy logs, application traces) where the token-endpoint POST body would otherwise echo it.

Apps can override per-provider via `ProviderConfig.tokenEndpointAuthMethod`:

```typescript
export default {
  providers: {
    legacy: {
      driver: 'oauth2',
      clientId: env('LEGACY_CLIENT_ID'),
      clientSecret: env('LEGACY_CLIENT_SECRET'),
      redirectUrl: 'https://app.com/auth/legacy/callback',
      tokenEndpointAuthMethod: 'post',  // secret in POST body
    },
  },
}
```

Facebook overrides the default to `'post'` because its Graph API token endpoint reads the secret from the body. Google, GitHub, Discord, and LinkedIn all accept Basic.

### Credentials

Never commit client secrets. Use environment variables and `.env` files with strict permissions.
