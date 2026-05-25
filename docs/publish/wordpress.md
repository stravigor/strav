# WordPress publisher

Publishes to the WordPress REST API v2. The simplest of the four adapters — Application Passwords (HTTP Basic auth) means there's no OAuth dance, no refresh, and no token expiry to worry about.

Authoritative reference: [WP REST API — Posts](https://developer.wordpress.org/rest-api/reference/posts/).

## Auth: Application Passwords

WordPress 5.6+ ships **Application Passwords** as the default machine-to-machine auth method. The SME generates a password under `Users → Profile → Application Passwords` in wp-admin and hands you `(username, application_password)`. The password is long-lived; revocation happens in the same UI.

Distinct from a regular login password — Application Passwords can only be used via the REST API, not for wp-admin login, and can be revoked individually.

OAuth1.0a and JWT are also possible but neither ships in WP core; both require third-party plugins. The adapter is hard-coded to Basic auth because that's the only stock-WP option.

## Credentials shape

```typescript
{
  accessToken: '<application_password>',
  metadata: {
    site_url: 'https://example.com',          // no trailing slash
    username: 'editor',
    featured_post_status: 'publish',          // optional; 'draft' / 'pending' also valid
  },
}
```

Persist with `PublisherCredentials.upsert`:

```typescript
import { PublisherCredentials } from '@strav/publish'

await PublisherCredentials.upsert({
  tenantId,
  platform: 'wordpress',
  accountId: new URL(siteUrl).host,           // 'example.com'
  accessToken: applicationPassword,
  refreshToken: null,
  metadata: { site_url: siteUrl, username },
})
```

## Publishing

```typescript
import { PublisherManager } from '@strav/publish'

await PublisherManager.publish({
  tenantId, platform: 'wordpress',
  content: {
    language: 'en',
    title: 'New butter croissant',
    body: '<p>Available all week. 65 baht.</p>',
    media: [{ kind: 'image', url: 'https://cdn.example.com/croissant.jpg' }],
  },
})
```

What the adapter does:

1. **Upload featured media** (first image in `content.media`) to `POST /wp-json/wp/v2/media`. WP doesn't accept URL references — the file is fetched from `media.url` and re-uploaded as the request body. The returned media ID becomes `featured_media` on the post.
2. **Create the post** via `POST /wp-json/wp/v2/posts` with `title`, `content`, `status`, and `meta.strav_language`.
3. **Return** `{ providerPostId: '<post_id>', url: '<post permalink>' }`.

### Field handling

| `PublishContent` field | Mapped to |
|---|---|
| `title` | `posts.title` (when missing, derived from the first non-empty line of `body`) |
| `body` | `posts.content` (raw — pass HTML if you want HTML) |
| `language` | `posts.meta.strav_language` (multilingual plugins like WPML / Polylang can pick this up) |
| `media[]` (first image) | uploaded to `/media`, attached as `featured_media` |
| `callToAction` | not used (no native CTA concept on stock WP posts) |
| `scheduledAt` | not used (set `status: 'future'` + `date` if you need this — file a PR) |

### Post status

`metadata.featured_post_status` overrides the post's initial status. Common values:

- `'publish'` (default) — live immediately.
- `'draft'` — saved as draft for human review.
- `'pending'` — submitted for editorial review.
- `'private'` — visible only to logged-in users with the right role.

Setting to anything other than `'publish'` is useful when you want a human to QA the AI-drafted post before it goes live.

## Errors

`PublishError` with `platform: 'wordpress'`. Common causes:

| Status | Likely cause |
|---|---|
| 401 | Wrong username or password, or Application Passwords disabled at the site level. |
| 403 | The user role lacks `publish_posts` capability. |
| 404 | `site_url` typo, or the site doesn't expose `/wp-json/` (rare — usually a security plugin blocking the REST API). |
| 5xx | Site is down or the host throttled. Let `@strav/durable` retry. |

## Testing

```typescript
import { WordPressPublisher } from '@strav/publish'

const p = new WordPressPublisher()
// Mock globalThis.fetch and assert against the URL / headers / body
```

See `packages/publish/tests/wordpress.test.ts` for the canonical example, including the two-step image upload + post creation test.

## Gotchas

- **Image fetch must succeed.** The adapter fetches `media.url` itself before uploading to WP. If the URL is private, signed, or geo-restricted in a way that's invisible to the strav app's egress, the fetch fails with `PublishError` and the post is never created. Hosts that protect their CDN behind tight IP allowlists need to allow your strav-app's egress IP.
- **No URL reference upload.** Pinging WP with an image URL alone doesn't work — the bytes have to flow through your app. For large videos this gets expensive; consider a `featured_video` plugin's custom endpoint instead.
- **Multilingual plugins vary.** WPML stores language in `wpml_language_code`, Polylang uses `pll_lang_id`, and our adapter writes `meta.strav_language` — pick a single source of truth in your theme/plugin glue code so the AI-drafted post lands in the right locale.
- **HTML vs plain text.** `posts.content` is rendered raw by default. If your `body` is plain text with newlines, expect the rendered post to be one long paragraph unless WP's `wpautop` filter wraps it. Pass HTML (`<p>...</p>`) if you want explicit control.
