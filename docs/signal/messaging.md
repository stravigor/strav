# Messaging

Instant-messaging integration with pluggable providers — **WhatsApp Cloud API**, **Facebook Messenger**, and **LINE Messaging API**. Outbound (text + media) and inbound (provider webhooks) are normalized to a common shape so application code never has to switch on the provider.

Stateless by design: parsers expose the provider's conversation/user IDs and reply tokens, but persistence (conversations, threads, read state) is left to the consuming application.

## Quick start

```typescript
import { messaging } from '@strav/signal'

// Fluent builder
await messaging.via('whatsapp')
  .to('+15551234567')
  .text('Order shipped — track at https://...')
  .media({ kind: 'image', url: 'https://cdn.example.com/label.png' })
  .send()

// Convenience method
await messaging.send({
  provider: 'line',
  to: 'U1234abcdef',
  text: 'Welcome!',
  media: [{ kind: 'image', url: 'https://cdn.example.com/hero.jpg' }],
})

// Reply to an inbound LINE message using the cheaper /reply endpoint
await messaging.via('line').to('IGNORED').text('Got it').replyTo('REPLY_TOKEN').send()
```

## Setup

### Using a service provider (recommended)

```typescript
import { MessagingProvider } from '@strav/signal'

app.use(new MessagingProvider())
```

The `MessagingProvider` registers `MessagingManager` as a singleton and, when `NotificationManager` is also registered, wires the WhatsApp / Messenger / LINE channels into the notification system. It depends on the `config` provider.

| Option | Default | Description |
|--------|---------|-------------|
| `registerNotificationChannels` | `true` | Register `whatsapp`, `messenger`, `line` notification channels so `BaseNotification.via()` can name them. |

To enable async sending via the queue, register the queue handler separately:

```typescript
import { messaging } from '@strav/signal'

messaging.registerQueueHandler()
```

### Manual setup

```typescript
import { MessagingManager } from '@strav/signal'

app.singleton(MessagingManager)
app.resolve(MessagingManager)
```

Create `config/messaging.ts`:

```typescript
import { env } from '@strav/kernel'

export default {
  default: env('MESSAGING_DRIVER', 'log'),

  whatsapp: {
    phoneNumberId: env('WHATSAPP_PHONE_NUMBER_ID', ''),
    accessToken: env('WHATSAPP_ACCESS_TOKEN', ''),
    appSecret: env('WHATSAPP_APP_SECRET', ''),
    verifyToken: env('WHATSAPP_VERIFY_TOKEN', ''),
  },

  messenger: {
    pageAccessToken: env('MESSENGER_PAGE_ACCESS_TOKEN', ''),
    appSecret: env('MESSENGER_APP_SECRET', ''),
    verifyToken: env('MESSENGER_VERIFY_TOKEN', ''),
  },

  line: {
    channelAccessToken: env('LINE_CHANNEL_ACCESS_TOKEN', ''),
    channelSecret: env('LINE_CHANNEL_SECRET', ''),
  },

  log: {
    output: env('MESSAGING_LOG_OUTPUT', 'console'),
  },
}
```

Only providers whose access token is populated are instantiated. The `log` transport is always available and is a safe default for development.

## Fluent builder

`messaging.via(provider)` returns a `PendingMessage` with chainable methods:

```typescript
await messaging.via('whatsapp')
  .to('+15551234567')                   // required: E.164, PSID, or LINE userId
  .text('Hello there')                  // optional when sending media-only
  .media({                              // call multiple times for multiple attachments
    kind: 'image',                      // 'image' | 'audio' | 'video' | 'file'
    url: 'https://cdn.example.com/x.jpg',
    caption: 'Optional caption',
  })
  .replyTo('wamid.PARENT')              // WhatsApp WAMID or LINE reply token
  .send()
```

`messaging.to(recipient)` is a shorthand that uses the configured default provider.

## Recipient identifiers

| Provider | `to` value |
|----------|------------|
| WhatsApp | E.164 phone (`'+15551234567'`) |
| Messenger | Page-Scoped User ID (PSID) — only available after the user messages the page first |
| LINE | `userId`, `groupId`, or `roomId` from a previous webhook event (LINE has no public discovery) |

## Media handling

Media is normalized to `{ kind, url?, mediaId?, filename?, contentType?, caption? }`. Each provider has its own constraints:

| Provider | Notes |
|----------|-------|
| WhatsApp | Pass `url` (Meta fetches it) **or** `mediaId` from a prior `/{phoneNumberId}/media` upload. Captions are dropped on `audio`. `file` maps to `document`. |
| Messenger | Pass `url` (preferred) or `attachment_id` via `mediaId`. Supports image / audio / video / file. |
| LINE | Pass `url`. `image` / `video` use the same URL for `originalContentUrl` and `previewImageUrl` when no preview is supplied. `file` is downgraded to a text message with the URL since LINE has no first-class document type. |

## Inbound messages

Each provider has a parser that verifies the request signature and normalizes the webhook payload to `ParsedInboundMessage[]`.

```typescript
import {
  WhatsAppInboundParser,
  MessengerInboundParser,
  LineInboundParser,
} from '@strav/signal'
```

A single webhook delivery often carries multiple events (multiple messages, status updates, postbacks). The parser returns only `type === 'message'` events; everything else (delivery receipts, read acks, follows, postbacks) is dropped.

```typescript
import { Router } from '@strav/http'
import { WhatsAppInboundParser } from '@strav/signal'

const parser = new WhatsAppInboundParser({ appSecret: env('WHATSAPP_APP_SECRET') })

router.post('/webhooks/whatsapp', async ctx => {
  // The HTTP layer must surface the RAW body — Meta's HMAC signature is
  // computed over the exact bytes Meta delivered. Re-stringifying JSON breaks
  // verification.
  const body = await ctx.request.arrayBuffer()
  const messages = await parser.parse({
    body: Buffer.from(body),
    headers: ctx.request.headers, // must be lowercased
  })

  for (const message of messages) {
    await processInboundMessage(message)
  }

  return ctx.text('OK')
})
```

### Signature verification

| Provider | Header | Algorithm | Secret |
|----------|--------|-----------|--------|
| WhatsApp | `X-Hub-Signature-256: sha256=<hex>` | HMAC-SHA256 over raw body | App secret |
| Messenger | `X-Hub-Signature-256: sha256=<hex>` | HMAC-SHA256 over raw body | App secret |
| LINE | `X-Line-Signature: <base64>` | HMAC-SHA256 over raw body | Channel secret |

All comparisons are constant-time. A tampered signature, missing header, or mismatched secret throws `AuthenticationError`.

### `ParsedInboundMessage`

```typescript
interface ParsedInboundMessage {
  provider: 'whatsapp' | 'messenger' | 'line'
  conversationId: string       // wa_id / PSID / userId | groupId | roomId
  fromUserId: string           // sender's provider-side ID
  fromName?: string            // when the provider includes profile inline
  text?: string
  media: MessagingMedia[]
  providerMessageId: string    // opaque, used for de-dup and replies
  replyToken?: string          // LINE only — single-use, ~30s TTL
  receivedAt: Date
  raw: unknown                 // original payload for provider-specific fields
}
```

### Webhook verification handshake (Meta)

WhatsApp and Messenger require an initial GET handshake to verify the webhook subscription. Use the configured `verifyToken`:

```typescript
router.get('/webhooks/whatsapp', ctx => {
  const params = ctx.request.query
  if (
    params['hub.mode'] === 'subscribe' &&
    params['hub.verify_token'] === env('WHATSAPP_VERIFY_TOKEN')
  ) {
    return ctx.text(params['hub.challenge'] ?? '')
  }
  return ctx.text('forbidden', 403)
})
```

LINE has no GET handshake.

## Notification integration

When `MessagingProvider` is registered alongside `NotificationProvider`, three notification channels (`whatsapp`, `messenger`, `line`) are auto-registered. Existing `BaseNotification` classes can name them in `via()`:

```typescript
import { BaseNotification, type Notifiable, type MessagingEnvelope } from '@strav/signal'

class OrderShipped extends BaseNotification {
  constructor(private trackingUrl: string) { super() }

  via(_: Notifiable) {
    return ['whatsapp', 'line']
  }

  toWhatsapp(_: Notifiable): MessagingEnvelope {
    return { text: `Your order has shipped: ${this.trackingUrl}` }
  }

  toLine(_: Notifiable): MessagingEnvelope {
    return {
      text: `Your order has shipped`,
      media: [{ kind: 'image', url: 'https://cdn.example.com/shipped.png' }],
    }
  }
}

await notify(user, new OrderShipped('https://track/abc'))
```

The recipient must implement the matching `routeNotificationFor*()` route methods:

```typescript
class User implements Notifiable {
  notifiableId() { return this.id }
  notifiableType() { return 'user' }
  routeNotificationForWhatsapp() { return this.phone }      // E.164
  routeNotificationForMessenger() { return this.psid }      // PSID
  routeNotificationForLine() { return this.lineUserId }     // LINE userId
}
```

Channels skip silently when either the envelope or the recipient route is missing.

## Testing

A `LogMessagingTransport` is always registered under `'log'` and prints messages to the console (or a file). It's the default when `MESSAGING_DRIVER=log`.

For unit tests, swap a transport in via `MessagingManager.useTransport()`:

```typescript
import { MessagingManager } from '@strav/signal'
import type { MessagingTransport } from '@strav/signal'

class CapturingTransport implements MessagingTransport {
  readonly name = 'whatsapp'
  readonly sent: unknown[] = []
  async send(message: unknown) { this.sent.push(message); return {} }
}

const transport = new CapturingTransport()
MessagingManager.useTransport(transport)
// ... call code under test ...
expect(transport.sent).toHaveLength(1)
MessagingManager.reset()
```

## Out of scope (follow-up)

- WhatsApp Business templates and interactive list / button messages.
- LINE Flex messages, rich menus, postback events.
- Messenger quick replies, personas, persistent menu.
- Persisted conversation / message tables.
- Telegram, Discord DMs, SMS — separate transports if/when needed.
