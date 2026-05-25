# LINE OA broadcast publisher

Publishes a post as a [LINE Messaging API broadcast](https://developers.line.biz/en/reference/messaging-api/#send-broadcast-message) — every friend of the OA receives the message at once.

Internally a thin wrapper over [`@strav/line`](../line/line.md)'s `LineClient.broadcast`. Each tenant has its own LINE Official Account with its own channel access token, so credentials are per-tenant.

## When to use vs. `@strav/line` directly

| Use case | API |
|---|---|
| Broadcast a marketing post to every friend of the tenant's OA | `PublisherManager.publish({ platform: 'line_broadcast', ... })` |
| Reply to a specific user's webhook event | `LineManager.client.reply(replyToken, message)` |
| Multicast to a curated recipient list | `LineManager.client.multicast(userIds, message)` |
| Push to one user | `LineManager.client.push(userId, message)` |

`line_broadcast` is the publisher-shape wrapper specifically for the "fan out a draft to every channel" use case. For interactive bot flows, stick with `@strav/line` directly.

## Auth

Long-lived **channel access token** from the LINE Developers console (Channel → Messaging API → Channel access token → Issue / Reissue). No refresh — the token lives until reissued.

## Credentials shape

```typescript
{
  accessToken: '<line_channel_access_token>',
  metadata: { channel_id: 'YOUR_CHANNEL_ID' },     // display only
}
```

Persist:

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
await PublisherManager.publish({
  tenantId, platform: 'line_broadcast',
  content: {
    language: 'th',
    body: 'มาแล้วครับ! ครัวซองต์เนยใหม่ 65 บาท เฉพาะสัปดาห์นี้',
    media: [{ kind: 'image', url: 'https://cdn.example.com/croissant.jpg' }],
  },
})
```

What the adapter does:

1. Builds a sequence of LINE outbound messages: one `text` message for `content.body`, then one `image` / `video` message per entry in `content.media`.
2. Truncates to LINE's hard ceiling of **5 messages per broadcast** (extras are silently dropped — log on your side if you regularly exceed this).
3. Posts to `/v2/bot/message/broadcast` via `LineClient.broadcast`.
4. Returns the raw LINE response; LINE does not surface per-message IDs on broadcasts, so `providerPostId` and `url` are undefined.

### Field handling

| `PublishContent` field | Mapped to |
|---|---|
| `body` | LINE `text` message |
| `media[]` (image) | LINE `image` message; `originalContentUrl` + `previewImageUrl` both set to `media.url` |
| `media[]` (video) | LINE `video` message; same URL pattern |
| `title`, `callToAction`, `language`, `location`, `scheduledAt` | not used |

For richer broadcast layouts (Flex bubbles, carousels, Quick Replies), use `@strav/line`'s [Flex builder](../line/flex.md) and call `LineClient.broadcast` directly — the publisher-shape adapter only covers plain text + media.

## Errors

`PublishError` with `platform: 'line_broadcast'`. Common causes:

| Status | Likely cause |
|---|---|
| 400 | Both `body` and `media` are empty; image URL not HTTPS; or message count > 5 (the adapter truncates, so this is rare). |
| 401 | Channel access token revoked or rotated. Re-issue from the LINE console and re-persist. |
| 429 | Monthly free-tier quota exhausted. LINE's [Light / Standard / Premium plans](https://developers.line.biz/en/services/messaging-api/) raise the ceiling. |

## Gotchas

- **Broadcasts are expensive.** Every broadcast counts against the OA's monthly message quota — push messages × OA friend count. For a 5,000-friend OA, one broadcast burns 5,000 messages. For "important customer" cohorts use `multicast` with a curated list instead.
- **No reply tokens / no per-recipient state.** Broadcasts don't get reply events, can't be targeted to specific users, and don't expose delivery receipts. If you need any of those, use `multicast` or `push`.
- **Image preview ≠ original.** The adapter sets `previewImageUrl = originalContentUrl` — fine for typical SME imagery (single 1080×1080 product shots), suboptimal for high-resolution photos. Generate a smaller preview URL and call `LineClient.broadcast` directly when this matters.
- **Multi-language.** The brief calls for "one post per language" — register one broadcast per selected language and run them as separate durable steps. The adapter is unaware of multi-language tabs.
