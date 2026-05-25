# LINE

Full LINE Messaging API SDK — **Flex Messages**, **Rich Menu**, **Quick Reply**, **message content download**, and **LIFF** server verification — for building LINE Official Account bots and LIFF webviews on Strav.

This package complements `@strav/signal`'s `LineTransport` (a unified messaging abstraction across WhatsApp / Messenger / LINE). Use `@strav/signal` when you need provider-agnostic text/media sends; reach for `@strav/line` when you need Flex bubbles, persistent Rich Menus, inbound media download, or LIFF authentication.

For LINE Login (the OAuth flow that signs a user into your website with their LINE account), see [`@strav/social`](../social/social.md) — the `LineProvider` lives there because it follows the same `AbstractProvider` contract as Google / Facebook / GitHub login.

For inbound webhook parsing (verifying `X-Line-Signature` and normalising message events), see [`@strav/signal/messaging`](../signal/messaging.md#inbound-messages) — the `LineInboundParser` is shared infrastructure.

## Quick start

```typescript
import { LineManager, flexMessage, bubble, box, text, button, postbackAction } from '@strav/line'

// Send a Flex preview card in reply to a LINE webhook event
await LineManager.client.reply(replyToken, flexMessage(
  'Preview ready',
  bubble({
    body: box('vertical', [
      text('New butter croissant', { weight: 'bold', size: 'lg' }),
      text('65 บาท', { color: '#888', margin: 'sm' }),
    ]),
    footer: box('horizontal', [
      button(postbackAction('action=publish', { label: 'Publish' }), { style: 'primary' }),
      button(postbackAction('action=edit', { label: 'Edit' }), { style: 'secondary' }),
    ]),
  })
))

// Fetch the binary content of an inbound voice note for transcription
const { bytes, contentType } = await LineManager.client.downloadContent(messageId)
```

## Install

```bash
bun add @strav/line
```

Peer dependencies (already present in a Strav app): `@strav/kernel`, `@strav/signal`.

## Setup

### Service provider

```typescript
import { LineProvider } from '@strav/line'

app.use(new LineProvider())
```

`LineProvider` registers `LineManager` as a singleton. It depends on the `config` provider and reads the `line.*` namespace.

### Configuration

Create `config/line.ts`:

```typescript
import { env } from '@strav/kernel'

export default {
  channelAccessToken: env('LINE_CHANNEL_ACCESS_TOKEN', ''),
  channelSecret: env('LINE_CHANNEL_SECRET', ''),

  // Optional — only needed for LIFF webview verification
  liff: {
    channelId: env('LINE_LIFF_CHANNEL_ID', ''),
  },

  // Optional — only needed if you're consuming the LineLogin OAuth client
  // outside of @strav/social
  login: {
    channelId: env('LINE_LOGIN_CHANNEL_ID', ''),
    channelSecret: env('LINE_LOGIN_CHANNEL_SECRET', ''),
  },
}
```

| Key | Required | Description |
|---|---|---|
| `channelAccessToken` | yes | Long-lived channel access token from the LINE Developers console. |
| `channelSecret` | for inbound | Channel secret used to verify the `X-Line-Signature` header on webhook deliveries. |
| `baseUrl` | no | Override the LINE API host. Default `https://api.line.me`. |
| `dataBaseUrl` | no | Override the LINE data-API host (content download / rich-menu image upload). Default `https://api-data.line.me`. |
| `liff.channelId` | LIFF only | LIFF channel ID — required when calling `LineManager.liff().verify(...)`. |
| `login.channelId` / `login.channelSecret` | Login only | LINE Login credentials. |

If `channelAccessToken` is missing, `LineManager` throws `ConfigurationError` at boot.

### Manual setup

```typescript
import { LineManager } from '@strav/line'

app.singleton(LineManager)
app.resolve(LineManager)
```

### Manager API

```typescript
LineManager.config            // resolved LineConfig
LineManager.client            // LineClient — messaging + media + profile
LineManager.richMenu          // RichMenuClient — see rich-menu.md
LineManager.liff()            // LiffVerifier — see liff.md; throws if not configured
LineManager.useClient(c)      // swap the client (testing)
LineManager.useRichMenu(c)    // swap the rich-menu client (testing)
LineManager.useLiff(v)        // swap the LIFF verifier (testing)
```

## `LineClient`

The direct messaging client. Unlike `@strav/signal`'s `LineTransport` (which sends one message via the unified `MessagingMessage` shape), `LineClient` accepts the full `LineMessage` union — including Flex Messages with Quick Replies and per-message Sender overrides — and lets you batch up to 5 messages per request.

```typescript
import { LineManager, type LineMessage } from '@strav/line'

const client = LineManager.client
```

### Push, reply, multicast, broadcast

```typescript
// Single recipient, immediate fan-out — uses /v2/bot/message/push
await client.push('U1234abcdef', message)
await client.push('U1234abcdef', [m1, m2, m3])

// Reply to an inbound event using its single-use reply token
// (cheaper than /push because it doesn't count against your push quota)
await client.reply(replyToken, message)

// Up to 500 recipients with the same payload
await client.multicast(['U1', 'U2', 'U3'], message)

// Every friend of the OA — heavy fan-out, use sparingly
await client.broadcast(message)
```

All four methods accept either a single `LineMessage` or an array (max 5 per request — `LINE_LIMITS.MESSAGES_PER_REQUEST`). Each returns the raw provider response untouched. Reply tokens are single-use and have a ~30 second TTL; consume them on the first response or fall back to `push`.

Optional flags:

```typescript
await client.push('U1', message, {
  notificationDisabled: true,                     // silent push
  customAggregationUnits: ['campaign-2026-05'],   // for /insight/message/event
})
```

### Message types

The `LineMessage` union covers every outbound message type LINE accepts:

| Type | Builder/construct | Notes |
|---|---|---|
| `text` | `{ type: 'text', text }` | Up to 5000 chars. Supports LINE emoji substitutions via `emojis: [...]`. |
| `sticker` | `{ type: 'sticker', packageId, stickerId }` | Use sticker IDs from the [LINE sticker list](https://developers.line.biz/en/docs/messaging-api/sticker-list/). |
| `image` | `{ type: 'image', originalContentUrl, previewImageUrl }` | Both URLs required, both must be HTTPS, both ≤ 10MB. |
| `video` | `{ type: 'video', originalContentUrl, previewImageUrl, trackingId? }` | Video ≤ 200MB, preview is a still JPG. |
| `audio` | `{ type: 'audio', originalContentUrl, duration }` | Duration in ms; ≤ 200MB. |
| `location` | `{ type: 'location', title, address, latitude, longitude }` | Renders as a map preview. |
| `flex` | `flexMessage(altText, bubble \| carousel)` | See [Flex Messages](./flex.md). |

Every message can carry a `quickReply` (up to 13 items) and a `sender` (per-message display name and icon override). See "Quick Reply" below.

### Content download

LINE does **not** provide public URLs for media a user sends to your bot — you must fetch it from the data-API host using the message ID surfaced by the inbound webhook parser:

```typescript
import { LineInboundParser } from '@strav/signal'
import { LineManager } from '@strav/line'

const parser = new LineInboundParser({ channelSecret })
const messages = await parser.parse({ body, headers })

for (const message of messages) {
  for (const media of message.media) {
    if (!media.mediaId) continue
    const { bytes, contentType } = await LineManager.client.downloadContent(media.mediaId)
    // upload to S3 / R2, pass to a transcription pipeline, etc.
  }
}
```

The endpoint returns the raw bytes plus the `Content-Type` header. Audio messages are typically `audio/m4a`; images are `image/jpeg`. Forward those exact bytes (and content type) to your object store so downstream consumers don't have to re-sniff.

### Profile fetch

```typescript
const profile = await LineManager.client.getProfile('U1234abcdef')
// { userId, displayName, pictureUrl?, statusMessage?, language? }
```

Only works for users who have added your OA as a friend. Returns `404` (thrown as `ExternalServiceError`) otherwise.

## Quick Reply

Quick replies render as horizontally scrolling buttons below a message. Up to 13 items per message.

```typescript
import type { TextMessage } from '@strav/line'

const message: TextMessage = {
  type: 'text',
  text: 'What would you like to do?',
  quickReply: {
    items: [
      { type: 'action', action: { type: 'message', label: 'New post', text: 'new post' } },
      { type: 'action', action: { type: 'postback', label: 'Approvals', data: 'action=approvals' } },
      { type: 'action', action: { type: 'uri', label: 'Help', uri: 'https://help.example.com' } },
      { type: 'action', action: { type: 'camera', label: 'Photo' } },
      { type: 'action', action: { type: 'cameraRoll', label: 'Gallery' } },
      { type: 'action', action: { type: 'location', label: 'Send location' } },
    ],
  },
}

await LineManager.client.reply(replyToken, message)
```

Quick replies are dismissed as soon as the user taps one item or sends any other message.

## Sender override

Override the display name and icon for a single message — useful for a multi-tenant OA where each tenant should appear as a distinct "bot":

```typescript
const message: TextMessage = {
  type: 'text',
  text: 'Order confirmed',
  sender: {
    name: 'Cafe Sundara',
    iconUrl: 'https://cdn.example.com/tenant/cafe-sundara/avatar.png',
  },
}
```

Name ≤ 20 chars, icon ≤ 1MB and a `https://` URL.

## Limits

Hard limits exposed on the `LINE_LIMITS` constant:

```typescript
import { LINE_LIMITS } from '@strav/line'

LINE_LIMITS.MESSAGES_PER_REQUEST    // 5
LINE_LIMITS.MULTICAST_RECIPIENTS    // 500
LINE_LIMITS.TEXT_MAX                // 5000
LINE_LIMITS.ALT_TEXT_MAX            // 400  (Flex altText)
LINE_LIMITS.QUICK_REPLY_MAX         // 13
LINE_LIMITS.FLEX_BUBBLE_BYTES       // 30_000
LINE_LIMITS.FLEX_CAROUSEL_BUBBLES   // 12
```

`LineClient` enforces `MESSAGES_PER_REQUEST` and `MULTICAST_RECIPIENTS` itself. Text and Flex limits are not auto-validated on send — wrap Flex payloads with `validateFlex()` (see [Flex Messages](./flex.md#validation)) before pushing them so you get a clear error in your code instead of a generic `400` from the LINE API.

## Errors

Every method throws `ExternalServiceError` (from `@strav/kernel`) on a non-2xx response, with `provider: 'LINE'`, the HTTP status, and the message field from the LINE error envelope when present. Input-shape errors (too many messages, empty replyToken, etc.) are thrown synchronously as `ExternalServiceError` with status `400` so app code can centralise on a single error class.

## Inbound messages

Inbound webhook handling lives in `@strav/signal`. Wire it up like this:

```typescript
import { Router } from '@strav/http'
import { LineInboundParser } from '@strav/signal'
import { LineManager } from '@strav/line'

const parser = new LineInboundParser({ channelSecret })

router.post('/webhooks/line', async ctx => {
  // The HTTP layer MUST surface the raw body — LINE computes HMAC over the
  // exact bytes it delivered. Re-stringified JSON breaks verification.
  const body = await ctx.request.arrayBuffer()
  const messages = await parser.parse({
    body: Buffer.from(body),
    headers: ctx.request.headers,
  })

  for (const message of messages) {
    if (message.text) await handleText(message)
    if (message.media.length) await handleMedia(message)
  }

  return ctx.text('OK')
})
```

See [`@strav/signal/messaging`](../signal/messaging.md#inbound-messages) for the full inbound contract, signature scheme, and the shape of `ParsedInboundMessage`.

## Testing

`LineManager` exposes `useClient`, `useRichMenu`, and `useLiff` swap hooks so tests can substitute fakes without touching the DI container:

```typescript
import { LineClient, LineManager } from '@strav/line'

class FakeLineClient extends LineClient {
  pushed: unknown[] = []
  override async push(to: string, messages: LineMessage | LineMessage[]) {
    this.pushed.push({ to, messages })
    return {}
  }
}

beforeEach(() => {
  LineManager.useClient(new FakeLineClient({ channelAccessToken: 'TEST' }))
})
```

The built-in tests mock `globalThis.fetch` directly (see `packages/line/tests/_fetch_mock.ts`).

## Next

- [Flex Messages](./flex.md) — typed AST, builder helpers, byte-size validation
- [Rich Menu](./rich-menu.md) — persistent menu management, image upload, per-user linking, grid helper
- [LIFF](./liff.md) — server-side LIFF ID token verification for webviews
- [`@strav/social`](../social/social.md) — LINE Login OAuth provider
- [`@strav/signal/messaging`](../signal/messaging.md) — inbound webhook parsing and the unified messaging fluent API
