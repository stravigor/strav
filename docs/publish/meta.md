# Meta publishers — Facebook + Instagram

Publishes to **Facebook Pages** and **Instagram Business** accounts via the Meta Graph API. Both share the same `meta` credentials row (one Page access token), differentiated by which adapter you dispatch to.

Authoritative references:
- [Facebook Pages API — Publishing](https://developers.facebook.com/docs/pages-api/posts/)
- [Instagram Content Publishing API](https://developers.facebook.com/docs/instagram-platform/content-publishing/)

## Auth: long-lived Page access tokens

Meta's OAuth dance gives you a short-lived **user access token**. The Pages API exchanges that for a **long-lived Page access token** (≈60 days) which is what you actually publish with. The `MetaOAuth` helper handles both steps and persists one `PublisherCredentials` row per Page the user granted.

**No automatic refresh.** Page tokens don't carry a refresh token; Meta requires the SME to re-consent before expiry. Add a scheduled job that watches `expiresAt` and pings the SME ~7 days ahead.

## Credentials shape

Set by `MetaOAuth.exchangeAndPersist`:

```typescript
{
  accessToken: '<long_lived_page_access_token>',
  metadata: {
    page_id: '123456789',
    page_name: 'Cafe Sundara',
    ig_account_id: '17841405...',   // null when the Page has no IG account linked
  },
  expiresAt: <60 days from issue>,
}
```

The same row is used by both `facebook` and `instagram` publishers — they look up by `(tenant, platform)` where platform is either `'facebook'` or `'instagram'`. **You'll currently want to write the same credentials under both platform names**, or register a thin wrapper Publisher that reads from `'meta'` and dispatches to the right surface. (A future helper to mirror automatically is on the roadmap.)

## OAuth flow

```typescript
import { MetaOAuth } from '@strav/publish'

const oauth = new MetaOAuth({
  clientId: env('META_APP_ID'),
  clientSecret: env('META_APP_SECRET'),
  redirectUrl: 'https://app.example.com/oauth/meta/callback',
  apiVersion: 'v21.0',  // optional
})

// Default scopes:
//   pages_show_list
//   pages_read_engagement
//   pages_manage_posts
//   instagram_basic
//   instagram_content_publish

router.get('/oauth/meta/start', ctx => {
  const state = randomHex(32)
  ctx.session.set('meta_state', state)
  return ctx.redirect(oauth.authUrl({ state }))
})

router.get('/oauth/meta/callback', async ctx => {
  if (ctx.query.get('state') !== ctx.session.get('meta_state')) {
    return ctx.text('Invalid state', 400)
  }
  const credentials = await oauth.exchangeAndPersist({
    tenantId: ctx.get('tenant').id,
    code: ctx.query.get('code')!,
  })
  // credentials.length === number of Pages the user authorised
  return ctx.json({ pagesConnected: credentials.length })
})
```

If the user has **no Facebook Pages**, `exchangeAndPersist` returns `[]` — surface that explicitly in your UI (it usually means the user signed in with a personal profile, not a business account).

## Facebook publishing

```typescript
await PublisherManager.publish({
  tenantId, platform: 'facebook',
  content: {
    language: 'en',
    body: 'New butter croissant — 65 baht',
    media: [{ kind: 'image', url: 'https://cdn.example.com/croissant.jpg' }],
    callToAction: { url: 'https://maps.app.goo.gl/...' },
  },
})
```

What `FacebookPagePublisher` does:

- With an image: `POST /{page-id}/photos` with `url`, `caption: body`, `access_token`.
- Without an image: `POST /{page-id}/feed` with `message: body`, `access_token`, optional `link: callToAction.url`.

Returns `{ providerPostId: '<page_id>_<post_id>', url: 'https://facebook.com/<page_id>_<post_id>' }`.

### Field handling

| `PublishContent` field | Mapped to |
|---|---|
| `body` | `message` (text post) or `caption` (photo post) |
| `media[]` (first image) | `url` on `/photos` |
| `media[]` (video) | not yet supported — video upload is a separate three-step flow |
| `callToAction.url` | `link` (text post only — Meta dropped the CTA buttons API a while back) |
| `title`, `language`, `location`, `scheduledAt` | not used |

## Instagram publishing

```typescript
await PublisherManager.publish({
  tenantId, platform: 'instagram',
  content: {
    language: 'th',
    body: 'มาแล้วครับ!',
    media: [{ kind: 'image', url: 'https://cdn.example.com/x.jpg' }],
    callToAction: { url: 'https://book.example.com' },
  },
})
```

The IG Content Publishing API is two-step:

1. **Create container.** `POST /{ig-user-id}/media` with `image_url` (or `video_url` + `media_type: REELS`) and `caption`. Returns `{ id: container_id }`.
2. **Publish container.** `POST /{ig-user-id}/media_publish` with `creation_id: container_id`. Returns `{ id: media_id }`.

The adapter does both calls in sequence. If the second call fails, the container is orphaned but harmless (it expires after 24 hours). Returns `{ providerPostId: '<media_id>', url: 'https://www.instagram.com/p/<media_id>' }`.

### Field handling

| `PublishContent` field | Mapped to |
|---|---|
| `body` | `caption` |
| `callToAction.url` | appended to `caption` after a blank line (IG has no CTA field; URLs in captions are not clickable by default but render as plain text) |
| `media[]` (image) | `image_url`, default `IMAGE` media_type |
| `media[]` (video) | `video_url` with `media_type: 'REELS'` |
| `title`, `language`, `location`, `scheduledAt` | not used |

### Text-only posts

**Instagram requires at least one image or video.** Calling with `body` only throws `PublishError` synchronously. If you want a "Story-style" text post, render it as an image with text overlay first.

## Errors

`PublishError` with `platform: 'meta'` (FB) or `'instagram'`. Meta's error envelope is `{ error: { message, type, code } }`; the adapter surfaces `error.message`.

| Status | Likely cause |
|---|---|
| 190 | Access token expired / revoked. Run the consent flow again. |
| 200 | Permissions error — the granted scopes don't include `pages_manage_posts` or `instagram_content_publish`. Re-consent with the correct scopes. |
| 400 | Invalid `image_url`, video too long, container still processing. |
| 100 (with subcode 33) | Page is unpublished or restricted. |

Meta's rate limits are per-app and per-page. 429-ish errors come back as `4` codes with type `OAuthException`; let `@strav/durable` retry with exponential backoff.

## Gotchas

- **Linked IG account required for IG publishing.** The Page must have an Instagram Business or Creator account linked in Facebook Business Suite. Personal IG accounts can't be published to via the API. `ig_account_id` is `null` in `metadata` when no IG is linked — surface that in your UI ("Connect your Instagram Business account to publish to IG").
- **Image URLs must be publicly fetchable by Meta's servers.** Signed URLs that expire quickly or geo-restricted CDNs will break the IG container creation step — the response is a vague 400. Test against a fresh URL on a controlled host before debugging the API.
- **Video / Reels still take time.** IG's `media_publish` may succeed but the actual Reel can take minutes to appear on the user's profile (transcoding). Don't poll — surface "Posted, may take a few minutes to appear" to the user.
- **Page tokens expire silently.** Meta won't email the SME. Build the proactive "your token expires in 7 days" notifier on day one — discovering this in production after a quiet weekend is painful.
- **API version pinning.** Default `apiVersion: 'v21.0'`. Pin a specific version in your config — Meta deprecates older versions on a ~2-year cycle. Adapter accepts an override in the constructor.
