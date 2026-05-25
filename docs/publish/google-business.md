# Google Business Profile publisher

Publishes to the [Google Business Profile Local Posts API](https://developers.google.com/my-business/reference/rest/v4/accounts.locations.localPosts). The highest-leverage channel for in-country tourist discovery — GBP posts boost local Maps ranking and feed Google's "near me" results.

## API access is gated

**Read this before integrating.** The GBP Posts API requires Google's allowlist approval. Apps that haven't completed the allowlist process get `403 PERMISSION_DENIED` on every `/localPosts` call even with valid OAuth tokens.

Request access via [Google's prereqs page](https://developers.google.com/my-business/content/prereqs#api-access) before building production flows. Allowlist review takes weeks. Sandboxed development against your own GBP account (signed in to GBP with the same Google account that owns the Cloud project) works without allowlist.

## Auth

OAuth 2 with refresh token. Scopes:

```
https://www.googleapis.com/auth/business.manage
```

Refresh tokens are issued only when the consent URL includes `access_type=offline` AND the user has never consented before — `GoogleBusinessOAuth.authUrl()` forces `prompt=consent` to keep this reproducible during development.

Access tokens are short-lived (~1 hour). The publisher's `refresh()` hook trades the stored `refresh_token` for a fresh access token via `https://oauth2.googleapis.com/token`; `PublisherManager` handles this transparently before each publish call.

## Credentials shape

Set by `GoogleBusinessOAuth.persistLocation`:

```typescript
{
  accessToken: '<short-lived access token>',
  refreshToken: '<long-lived refresh token>',
  expiresAt: <~1h from issue>,
  metadata: {
    account_name: 'accounts/123',
    location_name: 'locations/456',
    location_title: 'Cafe Sundara, Nimman',
  },
}
```

`accountId` on the credentials row holds the `location_name` (the URL-bearing identifier).

## OAuth flow

```typescript
import { GoogleBusinessOAuth } from '@strav/publish'

const oauth = new GoogleBusinessOAuth({
  clientId: env('GOOGLE_CLIENT_ID'),
  clientSecret: env('GOOGLE_CLIENT_SECRET'),
  redirectUrl: 'https://app.example.com/oauth/google/callback',
})

// 1. Consent
router.get('/oauth/google/start', ctx => {
  const state = randomHex(32)
  ctx.session.set('gbp_state', state)
  return ctx.redirect(oauth.authUrl({ state }))
})

// 2. Callback — exchange code, fetch the user's GBP accounts
router.get('/oauth/google/callback', async ctx => {
  if (ctx.query.get('state') !== ctx.session.get('gbp_state')) {
    return ctx.text('Invalid state', 400)
  }
  const { accessToken, refreshToken, expiresIn, accounts } =
    await oauth.exchangeAndListAccounts({ code: ctx.query.get('code')! })

  // Stash the fresh tokens while the user picks a location
  ctx.session.set('gbp_tokens', { accessToken, refreshToken, expiresIn })
  ctx.session.set('gbp_accounts', accounts)
  return ctx.redirect('/oauth/google/pick-location')
})

// 3. Location picker (your own UI)
router.get('/oauth/google/locations', async ctx => {
  const tokens = ctx.session.get('gbp_tokens')
  const account = ctx.query.get('account')!  // 'accounts/123'
  const locations = await oauth.listLocations({
    accessToken: tokens.accessToken,
    accountName: account,
  })
  return ctx.json({ locations })
})

// 4. Persist the chosen location
router.post('/oauth/google/pick-location', async ctx => {
  const { accountName, locationName, locationTitle } = await ctx.request.json()
  const tokens = ctx.session.get('gbp_tokens')
  await oauth.persistLocation({
    tenantId: ctx.get('tenant').id,
    accountName, locationName, locationTitle,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresIn: tokens.expiresIn,
  })
  ctx.session.forget('gbp_tokens')
  ctx.session.forget('gbp_accounts')
  return ctx.json({ ok: true })
})
```

The two-step "list accounts → pick location" flow handles the common case where an SME's Google account manages multiple physical locations.

## Publishing

```typescript
await PublisherManager.publish({
  tenantId, platform: 'google_business',
  content: {
    language: 'th',
    body: 'มาแล้วครับ! ครัวซองต์เนยใหม่ 65 บาท เฉพาะสัปดาห์นี้',
    media: [{ kind: 'image', url: 'https://cdn.example.com/croissant.jpg' }],
    callToAction: { url: 'https://maps.app.goo.gl/...' },
  },
})
```

What `GoogleBusinessProfilePublisher` does:

- `POST /v4/{account_name}/{location_name}/localPosts` with:
  - `languageCode`: BCP-47 from `content.language`
  - `summary`: `content.body`
  - `topicType: 'STANDARD'`
  - `media`: `[{ mediaFormat: 'PHOTO', sourceUrl: media[0].url }]` (first image only)
  - `callToAction`: `{ actionType: 'LEARN_MORE', url: callToAction.url }` when set
- Returns `{ providerPostId: 'accounts/.../locations/.../localPosts/...', url: <search url if returned> }`.

### Field handling

| `PublishContent` field | Mapped to |
|---|---|
| `language` | `languageCode` (BCP-47, e.g. `th`, `en`, `zh-CN`) |
| `body` | `summary` (≤ 1500 chars per Google's hard limit) |
| `media[]` (first image) | `media[0]` with `mediaFormat: 'PHOTO'` |
| `callToAction.url` | `callToAction.url` with `actionType: 'LEARN_MORE'` |
| `title`, `location`, `scheduledAt` | not used (use `topicType: 'EVENT'` flow for scheduled events — file a PR) |

### Topic types

The adapter sends `topicType: 'STANDARD'` for every post. Google supports four:

| Type | When |
|---|---|
| `STANDARD` | Generic update — what we use. |
| `EVENT` | Time-bounded event with `event.title`, `event.schedule`. |
| `OFFER` | Promotion with `offer.couponCode`, `offer.redeemOnlineUrl`. |
| `ALERT` | COVID-style notice (mostly historical at this point). |

Adapter limitation: only STANDARD is mapped. Wrap or extend `GoogleBusinessProfilePublisher` if you need the others.

## Errors

`PublishError` with `platform: 'google_business'`. Google's error envelope is `{ error: { code, message, status } }`; the adapter surfaces `error.message`.

| Status | Likely cause |
|---|---|
| 401 | Access token expired and refresh failed. Check `refresh_token` is still valid (revoked tokens require re-consent). |
| 403 | Most often **API access not allowlisted**. Also: the OAuth user lost permission on the GBP location. |
| 404 | `account_name` or `location_name` is wrong, or the location was deleted. |
| 429 | Rate-limited. GBP's quotas are tight — leave headroom in your durable workflow's backoff. |

`CredentialsRefreshError` fires when the refresh token itself is rejected (revoked, or the user changed their Google password). Catch it and surface a "Reconnect Google" banner.

## Gotchas

- **Allowlist is the biggest blocker.** Build mock-mode integration tests against a fake `localPosts` server while you wait for Google's allowlist approval — burning the development loop on real Google calls is slow and frustrating.
- **Location resource names.** Modern GBP uses `locations/{id}` (without an `accounts/` prefix) for some endpoints and `accounts/{id}/locations/{id}` for others. The Posts endpoint wants the concatenated form (`{accountName}/{locationName}`) which is what the adapter constructs from metadata.
- **Photo sourceUrl must be public.** Google's servers fetch the image from `sourceUrl`. Signed URLs, geo-blocked CDNs, and ungzipped JPEGs > 5MB are common failure modes; the API error is unhelpfully generic.
- **Language codes are unforgiving.** Use BCP-47 (`en`, `th`, `zh-CN`, `ja`, `ko`, `ru`) — `english` or `en_US` get rejected.
- **No update / delete in the adapter.** Local Posts can be updated and deleted via the API (`PATCH`, `DELETE`), but `Publisher.publish` only creates. Call the API directly with the stored access token if you need edit/delete; refresh first via `PublisherManager.refreshIfExpired(publisher, credentials)`.
- **GBP doesn't support multilingual posts natively.** You publish one localized post per language — same pattern as other adapters. Each language is a separate durable step.
