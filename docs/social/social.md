# Social

The social module (`@strav/social`) provides OAuth 2.0 social authentication with a fluent, driver-based API. Users click "Sign in with Google" (or GitHub, Discord, etc.), get redirected to the provider, and come back with a verified profile you can use to create or log in a user.

Built-in providers: **Google**, **GitHub**, **Discord**, **Facebook**, **LinkedIn**. Custom providers can be added via `extend()`.

Requires the `session()` middleware from the [session module](./session.md) for CSRF state verification (unless running in stateless mode).

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

    // githubUser.id       → "12345"
    // githubUser.name     → "John Doe"
    // githubUser.email    → "john@example.com"
    // githubUser.avatar   → "https://avatars.githubusercontent.com/u/12345"
    // githubUser.nickname → "johndoe"
    // githubUser.token    → "gho_xxxx..."

    // Find or create your app user
    let user = await User.findBy('email', githubUser.email)
    if (!user) {
      user = new User()
      user.merge({ name: githubUser.name, email: githubUser.email })
      await user.save()
    }

    // Link the social account (or update tokens if already linked)
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

### Stateless mode

Skip session-based CSRF state verification. Useful for SPAs or token-based APIs where you manage state yourself:

```typescript
// Redirect (no state stored in session)
social.driver('google').stateless().redirect(ctx)

// Callback (no state verification)
const user = await social.driver('google').stateless().user(ctx)
```

### User from token

If you already have an access token (e.g., from a mobile app), fetch the user profile directly without the redirect flow:

```typescript
const user = await social.driver('google').userFromToken(accessToken)
```

## Built-in providers

### Google

- Default scopes: `openid`, `email`, `profile`
- User fields: `sub` → id, `name` → name, `email` → email, `picture` → avatar
- Supports the `hd` parameter to restrict to a Google Workspace domain:

```typescript
social.driver('google').with({ hd: 'mycompany.com' }).redirect(ctx)
```

### GitHub

- Default scopes: `read:user`, `user:email`
- User fields: `id` → id, `login` → nickname, `name` → name, `avatar_url` → avatar
- Automatically fetches the primary verified email from `/user/emails` when the profile email is private

### Discord

- Default scopes: `identify`, `email`
- User fields: `id` → id, `username` → nickname, `global_name` → name, `email` → email
- Avatar URL is computed from the user's ID and avatar hash, with a default fallback

To request guild information:

```typescript
social.driver('discord').scopes(['guilds']).redirect(ctx)
```

### Facebook

- Default scopes: `email`, `public_profile`
- User fields: `id` → id, `name` → name, `email` → email, `picture.data.url` → avatar
- Uses Graph API v21.0

To request additional permissions:

```typescript
social.driver('facebook').scopes(['user_birthday', 'user_location']).redirect(ctx)
```

### LinkedIn

- Default scopes: `openid`, `profile`, `email`
- User fields: `sub` → id, `name` → name, `email` → email, `picture` → avatar
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

All methods return or accept a `SocialAccountData` object:

| Field | Type | Description |
|-------|------|-------------|
| `id` | `number` | Auto-incrementing primary key |
| `userId` | `string \| number` | Foreign key to the user table |
| `provider` | `string` | Provider name (e.g. `'github'`) |
| `providerId` | `string` | User's ID from the provider |
| `token` | `string` | OAuth access token |
| `refreshToken` | `string \| null` | Refresh token |
| `expiresAt` | `Date \| null` | Token expiry |
| `createdAt` | `Date` | Row creation time |
| `updatedAt` | `Date` | Last update time |

## Security

- **CSRF state**: By default, a random 64-character hex string is stored in the session before redirect and verified on callback. This prevents cross-site request forgery attacks.
- **State is single-use**: The state value is removed from the session after verification.
- **Stateless mode**: Only use `stateless()` when you manage CSRF protection through other means (e.g., SPA with its own state parameter).
- **Credentials**: Never commit client secrets. Use environment variables and `.env` files with strict permissions.
