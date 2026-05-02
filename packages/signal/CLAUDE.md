# @strav/signal

Communication layer for the Strav framework — mail, notifications, instant messaging (WhatsApp / Messenger / LINE), real-time broadcasting, and Server-Sent Events (SSE).

## Dependencies
- @strav/kernel (peer)
- @strav/http (peer)
- @strav/view (peer)
- @strav/database (peer)
- @strav/queue (peer)
- nodemailer (for SMTP transport)
- juice (for CSS inlining)

## Commands
- bun test
- bun run typecheck

## Architecture
- src/mail/ — MailManager, transports (SMTP, Resend, SendGrid, Mailgun, Alibaba, Log), CSS inliner
- src/mail/inbound/ — inbound email: webhook parsers (Postmark, Mailgun) with HMAC verification where applicable, IMAP driver (imapflow + mailparser) with pluggable client factory for testing, loop-guard helper, canonical ParsedInboundMail type. SendGrid / SES webhooks + OAuth2 (Gmail/M365) IMAP pending. `mail.poll(...)` helper schedules IMAP polls via @strav/queue's Scheduler.
- src/notification/ — NotificationManager, BaseNotification, channels (email, database, webhook, Discord). When MessagingProvider is registered, `whatsapp` / `messenger` / `line` channels are added too — `BaseNotification` exposes optional `toWhatsapp()` / `toMessenger()` / `toLine()` envelope builders.
- src/broadcast/ — BroadcastManager (server), Broadcast/Subscription (client)
- src/sse/ — SSEManager (server), SSEClient (client), parser utilities
- src/messaging/ — MessagingManager, transports (WhatsApp Cloud API, Messenger Send API, LINE Messaging API, Log), inbound webhook parsers (X-Hub-Signature-256 for Meta, X-Line-Signature for LINE), MessagingChannel adapter for notifications. Stateless pass-through — parsers expose conversation/user IDs and reply tokens, persistence is the consumer's responsibility.
- src/providers/ — MailProvider, NotificationProvider, BroadcastProvider, MessagingProvider

## Key Exports

### From root (@strav/signal)
- All mail, notification, messaging, broadcast, SSE, and provider exports

### From subpaths
- @strav/signal/mail — Mail functionality (mail helper, PendingMail, transports)
- @strav/signal/notification — Notification functionality (notify, BaseNotification, channels)
- @strav/signal/messaging — Instant messaging (messaging helper, PendingMessage, transports, inbound parsers)
- @strav/signal/broadcast — Broadcasting (broadcast helper, BroadcastManager, client classes)
- @strav/signal/sse — Server-Sent Events (sse helper, SSEManager, SSEClient, parser utilities)
- @strav/signal/providers — Service providers

## Import Conventions
- ALWAYS import from root barrel: `import { mail, notify, broadcast, sse } from '@strav/signal'`
- Subpath imports allowed for specific features:
  - `import { Broadcast } from '@strav/signal/broadcast'` (WebSocket client)
  - `import { SSEClient } from '@strav/signal/sse'` (SSE client)
- Never use deep imports beyond documented subpaths

## Usage Patterns

### Mail
- Primary API: `mail` helper object with fluent builder pattern
- Queue integration: `.queue()` method for async sending
- Template rendering: Uses @strav/view's ViewEngine

### Notifications
- Primary API: `notify()` function with BaseNotification classes
- Multi-channel: via() method determines channels
- Database storage: Automatic with DatabaseChannel

### Messaging (instant messaging)
- Primary API: `messaging` helper with fluent builder (`messaging.via('whatsapp').to(...).text(...).send()`)
- Multi-provider: WhatsApp / Messenger / LINE; transports are looked up by name (no single "default transport" model — IM apps fan out across providers in parallel)
- Inbound: each provider has a webhook parser that verifies signature (X-Hub-Signature-256 for WhatsApp/Messenger, X-Line-Signature for LINE) and normalizes to ParsedInboundMessage[]
- Notification routing: when MessagingProvider is registered, channels named after the providers are auto-registered in NotificationManager
- HTTP layer must surface RAW request body to inbound parsers — Meta and LINE compute HMAC over the exact bytes; re-stringifying JSON breaks verification

### Broadcasting
- Server: `broadcast` helper for channel setup and sending
- Client: `Broadcast` class for WebSocket subscription
- Authorization: Channel-specific auth callbacks

### Server-Sent Events (SSE)
- Server: `sse` helper for channel setup and one-way server-to-client streaming
- Client: `SSEClient` class with auto-reconnection and channel subscriptions
- Streaming: Support for both async generators and ReadableStream
- HTTP Integration: `ctx.sse()` method in @strav/http for easy SSE responses
- Parser: Enhanced SSE parser moved from @strav/brain with formatting utilities

## Testing Considerations
- Mail: LogTransport for testing without sending
- Notifications: Mock notifiables with required interface
- Messaging: LogMessagingTransport always registered; swap fakes in via `MessagingManager.useTransport()` and reset via `MessagingManager.reset()`
- Broadcasting: WebSocket testing requires running server
- SSE: Parser has comprehensive unit tests, integration tests use mock streams
