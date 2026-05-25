# Publish

Unified multi-channel publisher — **Google Business Profile**, **Facebook Pages**, **Instagram**, **WordPress**, and **LINE OA broadcasts** behind a single `Publisher` interface, with per-tenant OAuth credentials, automatic token refresh, and encryption at rest.

Use `@strav/publish` when you have one piece of content to fan out to many destinations on behalf of a tenant (typical SaaS scenario: an SME-owned LINE bot drafts a post, gets approval, and pushes it to every connected channel). The package keeps the platform-specific quirks (Meta's two-step Instagram flow, Google's allowlist, WordPress's Application Passwords) behind a normalized `publish({ tenantId, platform, content })` call.

For the fan-out orchestration itself — retrying each platform independently, scheduling, sagas — pair this with [`@strav/durable`](../durable/durable.md): each (tenant, platform, language) tuple is one durable step.

## Quick start

```typescript
import {
  PublisherManager,
  WordPressPublisher,
  LineBroadcastPublisher,
  FacebookPagePublisher,
  InstagramPublisher,
  GoogleBusinessProfilePublisher,
} from '@strav/publish'

// Wiring (typically in your app's bootstrap)
PublisherManager.register(new WordPressPublisher())
PublisherManager.register(new LineBroadcastPublisher())
PublisherManager.register(new FacebookPagePublisher())
PublisherManager.register(new InstagramPublisher())
PublisherManager.register(
  new GoogleBusinessProfilePublisher({
    clientId: env('GOOGLE_CLIENT_ID'),
    clientSecret: env('GOOGLE_CLIENT_SECRET'),
  })
)

// Publish (typically from a durable workflow step)
await PublisherManager.publish({
  tenantId: tenant.id,
  platform: 'google_business',
  content: {
    language: 'en',
    body: 'New butter croissant — 65 baht, this week only',
    media: [{ kind: 'image', url: 'https://cdn.example.com/croissant.jpg' }],
    callToAction: { url: 'https://maps.app.goo.gl/abc' },
  },
})
```

The manager:
1. Looks up the `(tenant, platform)` credentials row (auto-decrypted).
2. Refreshes the access token if it's expired or expiring soon (60s skew).
3. Persists the new tokens.
4. Dispatches to the registered publisher.
5. Returns a normalized `PublishResult` with `providerPostId` and the canonical URL when the platform exposes one.

## Install

```bash
bun add @strav/publish
```

Peer dependencies: `@strav/kernel`, `@strav/database`, `@strav/http`, `@strav/line`.

## Setup

### Service provider

```typescript
import { PublishProvider } from '@strav/publish'

app.use(new PublishProvider())
```

`PublishProvider` registers `PublisherManager` as a singleton (depends on `config` and `database`). It does **not** auto-register any concrete publishers — apps register the ones they need with their own configuration, typically in a follow-up app provider or directly in the bootstrap file.

### Configuration

```typescript
// config/publish.ts
import { env } from '@strav/kernel'

export default {
  /** Tenant FK column suffix — should match your tenant registry choice. */
  tenantKey: env('PUBLISH_TENANT_KEY', 'id'),
  /** Refresh window in seconds. Tokens expiring inside this window are refreshed. */
  refreshSkewSeconds: 60,
}
```

The `tenantKey` works with `config.database.tenant.table` to derive the FK column on `publisher_credentials` — same convention used elsewhere in Strav's multi-tenant story.

### Schema

Copy or re-export the credentials schema in your app:

```typescript
// database/schemas/publisher_credentials.ts
export { default } from '@strav/publish/stubs/schemas/publisher_credentials'
```

The schema is `tenanted: true` so `@strav/database`'s `withTenant(id, fn)` automatically scopes reads and writes. After adding the file, generate and run a migration:

```bash
bun strav generate:migration -m "add publisher_credentials"
bun strav migrate
```

## Core concepts

### `PublishContent` — the canonical input shape

```typescript
interface PublishContent {
  language: LanguageTag                              // BCP-47, e.g. 'en', 'th', 'zh-CN'
  title?: string                                     // WordPress + fallback caption
  body: string                                       // main text — required
  media?: PublishMedia[]                             // image / video attachments
  callToAction?: { label?: string; url: string }    // GBP buttons, Meta links
  location?: { latitude, longitude, name? }         // GBP events
  scheduledAt?: Date                                 // for platforms that support it
}
```

Each `publish()` call carries **one language** for **one platform**. Multi-language fan-out (3 languages × 4 platforms = 12 calls) is the caller's responsibility — orchestrate with `@strav/durable` so each call is its own retryable step. Publishers translate the shape into platform-specific payloads and silently drop fields they don't support.

### `Publisher` — adapter contract

```typescript
interface Publisher {
  readonly name: string
  publish(credentials, content): Promise<PublishResult>
  refresh?(credentials): Promise<RefreshedTokens>   // optional; required for OAuth platforms
}
```

Built-in publishers and their `name` values:

| `name` | Class | Auth | Refresh? |
|---|---|---|---|
| `wordpress` | `WordPressPublisher` | Application Passwords (HTTP Basic) | no |
| `line_broadcast` | `LineBroadcastPublisher` | LINE channel access token | no |
| `facebook` | `FacebookPagePublisher` | Page access token (long-lived) | no — re-consent before expiry |
| `instagram` | `InstagramPublisher` | Same Page access token as FB | no — re-consent before expiry |
| `google_business` | `GoogleBusinessProfilePublisher` | OAuth 2 with refresh token | yes |

Apps can register custom publishers (Wongnai, TripAdvisor) under any name — `Publisher` is structural, not branded.

### `PublisherCredentials` — tenant-scoped store

One row per `(tenant_id, platform, account_id)`. `account_id` is the platform-side identifier: GBP location resource name, Facebook Page ID, WordPress site host, LINE channel ID.

Access tokens and refresh tokens are encrypted at rest with the `enc:v1:` sentinel prefix (same scheme as `@strav/social`'s token storage — see [security notes](../social/social.md#token-storage-at-rest)).

```typescript
import { PublisherCredentials } from '@strav/publish'

await PublisherCredentials.findOne(tenantId, 'google_business')
await PublisherCredentials.findByTenant(tenantId)
await PublisherCredentials.upsert({ tenantId, platform, accountId, accessToken, ... })
await PublisherCredentials.delete(id)
PublisherCredentials.isExpired(credentials, skewSeconds?)
```

You usually don't call these methods directly — `PublisherManager.publish()` reads + refreshes + dispatches as a unit. Read them yourself for admin views (list connected accounts, show last-refresh time).

## Connecting an account (OAuth flow)

`@strav/publish` ships per-platform OAuth helpers that handle the platform-specific consent-and-persist steps. They live in `@strav/publish/oauth` and are distinct from `@strav/social` (which is for sign-in-with-X, user-scoped, not tenant-scoped).

### Meta (Facebook + Instagram)

```typescript
import { MetaOAuth } from '@strav/publish'

const oauth = new MetaOAuth({
  clientId: env('META_APP_ID'),
  clientSecret: env('META_APP_SECRET'),
  redirectUrl: 'https://app.example.com/oauth/meta/callback',
})

// 1. Redirect the user
router.get('/oauth/meta/start', ctx => {
  const state = randomHex(32)
  ctx.session.set('meta_oauth_state', state)
  return ctx.redirect(oauth.authUrl({ state }))
})

// 2. Handle the callback — persists one credentials row per Page the user granted
router.get('/oauth/meta/callback', async ctx => {
  const state = ctx.query.get('state')
  if (state !== ctx.session.get('meta_oauth_state')) {
    return ctx.text('Invalid state', 400)
  }
  ctx.session.forget('meta_oauth_state')

  const tenantId = ctx.get('tenant').id
  const credentials = await oauth.exchangeAndPersist({
    tenantId,
    code: ctx.query.get('code')!,
  })
  return ctx.json({ pagesConnected: credentials.length })
})
```

After this, `(tenantId, 'facebook')` and `(tenantId, 'instagram')` credential rows are available — both adapters publish using the same underlying Page access token via the connected Page's `ig_account_id` metadata.

### Google Business Profile

GBP needs a two-stage flow because most users have multiple business locations. The OAuth callback returns the available accounts; your UI lets the user pick one location to connect.

```typescript
import { GoogleBusinessOAuth } from '@strav/publish'

const oauth = new GoogleBusinessOAuth({
  clientId: env('GOOGLE_CLIENT_ID'),
  clientSecret: env('GOOGLE_CLIENT_SECRET'),
  redirectUrl: 'https://app.example.com/oauth/google/callback',
})

// 1. Redirect to consent
router.get('/oauth/google/start', ctx =>
  ctx.redirect(oauth.authUrl({ state: ctx.session.id }))
)

// 2. Callback: exchange and show the account picker
router.get('/oauth/google/callback', async ctx => {
  const { accessToken, refreshToken, expiresIn, accounts } =
    await oauth.exchangeAndListAccounts({ code: ctx.query.get('code')! })

  // Stash the freshly minted tokens in the session while the user picks
  ctx.session.set('gbp_tokens', { accessToken, refreshToken, expiresIn })
  ctx.session.set('gbp_accounts', accounts)

  return ctx.redirect('/oauth/google/pick-location')
})

// 3. Location picker
router.post('/oauth/google/pick-location', async ctx => {
  const { accountName, locationName, locationTitle } = await ctx.request.json()
  const tokens = ctx.session.get('gbp_tokens')

  await oauth.persistLocation({
    tenantId: ctx.get('tenant').id,
    accountName,
    locationName,
    locationTitle,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresIn: tokens.expiresIn,
  })
  ctx.session.forget('gbp_tokens')
  ctx.session.forget('gbp_accounts')
  return ctx.json({ ok: true })
})
```

**GBP API access is gated.** Apps must request allowlist approval from Google before `/localPosts` calls work in production. See [Google's prereqs page](https://developers.google.com/my-business/content/prereqs#api-access). Sandboxed development against your own GBP account works without allowlist.

### WordPress

No OAuth — the SME generates an Application Password under `Users → Profile → Application Passwords` in wp-admin, then hands it to your onboarding form. Store it via `PublisherCredentials.upsert`:

```typescript
await PublisherCredentials.upsert({
  tenantId,
  platform: 'wordpress',
  accountId: new URL(siteUrl).host,
  accessToken: applicationPassword,
  refreshToken: null,
  metadata: { site_url: siteUrl, username },
})
```

### LINE OA broadcast

Per-tenant channel access token from the LINE Developers console:

```typescript
await PublisherCredentials.upsert({
  tenantId,
  platform: 'line_broadcast',
  accountId: channelId,
  accessToken: channelAccessToken,
  refreshToken: null,
  metadata: { channel_id: channelId },
})
```

## Publishing

```typescript
const result = await PublisherManager.publish({
  tenantId: 'acme',
  platform: 'instagram',
  content: {
    language: 'th',
    body: 'มาแล้วครับ! คาเฟ่เปิดวันเสาร์-อาทิตย์',
    media: [{ kind: 'image', url: 'https://cdn.example.com/cafe.jpg' }],
  },
})

result.providerPostId   // e.g. '17912345678'
result.url              // e.g. 'https://www.instagram.com/p/17912345678'
result.raw              // original platform response
```

Pass `accountId` when the tenant has multiple credential rows for the same platform (multiple Facebook Pages, multiple GBP locations):

```typescript
await PublisherManager.publish({
  tenantId, platform: 'google_business',
  accountId: 'locations/123456',  // disambiguate
  content,
})
```

If no `accountId` is given, the first credential found for `(tenant, platform)` is used. Most apps have one account per platform per tenant and don't need to think about this.

### Pairing with `@strav/durable`

The natural fan-out pattern: one durable workflow per content draft, with one step per (platform, language) tuple. Each step is independently retried, idempotent, and recoverable across restarts.

```typescript
durable('publish_draft')
  .parallel(['google_business', 'facebook', 'instagram', 'wordpress', 'line_broadcast'].flatMap(platform =>
    selectedLanguages.map(language => ({
      step: `${platform}:${language}`,
      run: () => PublisherManager.publish({ tenantId, platform, content: translated[language] }),
    }))
  ))
  .compensate(/* unpublish on partial failure */)
```

See [`@strav/durable`](../durable/durable.md) for the full saga / compensation patterns.

## Errors

| Class | When |
|---|---|
| `PublishError` | Platform API returned non-2xx, or input validation failed inside an adapter. Carries `.platform`, `.status?`, `.raw?`. |
| `CredentialsNotFoundError` | No `(tenant, platform[, accountId])` row in the credentials store. App needs to run the consent flow first. |
| `CredentialsRefreshError` | Token was expired and refresh failed (or the publisher has no `refresh()` hook). For OAuth platforms, the SME needs to re-consent. |
| `PublisherNotRegisteredError` | No publisher registered under the given name. Wire up `PublisherManager.register(...)` at boot. |

Catch shape, applied to the durable workflow:

```typescript
try {
  await PublisherManager.publish({ tenantId, platform, content })
} catch (err) {
  if (err instanceof CredentialsRefreshError) {
    // Token can't be refreshed — surface a re-connect banner to the SME
    await notifyReconnect(tenantId, err.platform)
    return { skipped: true, reason: 'reconnect_required' }
  }
  if (err instanceof PublishError && err.status === 429) {
    // Rate-limited — let durable's backoff retry
    throw err
  }
  throw err
}
```

## Per-platform notes

See the dedicated pages for the adapter-specific behaviour:

- [Google Business Profile](./google-business.md) — Local Posts API, allowlist, locale codes
- [Meta (Facebook + Instagram)](./meta.md) — Page tokens, two-step IG flow, Reels
- [WordPress](./wordpress.md) — Application Passwords, featured media upload
- [LINE OA broadcasts](./line-broadcast.md) — wraps `@strav/line` `LineClient.broadcast`

## Testing

`PublisherManager` exposes `register` / `reset` so tests can swap in fake publishers:

```typescript
import { PublisherManager } from '@strav/publish'
import type { Publisher } from '@strav/publish'

class FakeWP implements Publisher {
  readonly name = 'wordpress'
  published: unknown[] = []
  async publish(_creds, content) {
    this.published.push(content)
    return { providerPostId: 'fake-1' }
  }
}

beforeEach(() => {
  PublisherManager.reset()
  PublisherManager.register(new FakeWP())
})
```

The built-in adapter tests mock `globalThis.fetch` directly. See `packages/publish/tests/_fetch_mock.ts` for the helpers and `packages/publish/tests/wordpress.test.ts` (or any sibling test) for usage patterns.

## Security

- **Encryption at rest.** `accessToken` and `refreshToken` are encrypted via `EncryptionManager` before persistence, with the `enc:v1:` sentinel prefix. Initialise `EncryptionManager.useKey()` in test setup. Legacy plaintext rows (predating encryption) are returned as-is and re-encrypted on next `updateTokens()` call.
- **RLS tenant scoping.** `publisher_credentials` is `tenanted: true` — every read/write is automatically scoped by `current_setting('app.tenant_id')`. Run publishes inside `withTenant(id, fn)`.
- **Refresh-on-flight.** `isExpired()` has a 60-second skew so a token that dies mid-call is refreshed before dispatch.
- **No token leakage in errors.** `PublishError.raw` carries the platform's error response, which may include the request URL but not the access token (the token is in headers / form bodies that adapters don't echo).

## Next

- Per-adapter docs in this directory.
- [`@strav/durable`](../durable/durable.md) for the orchestration layer above this.
- [`@strav/line`](../line/line.md) for the LINE bot UX that drives content into this pipeline.
