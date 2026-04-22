# @strav/signal

Communication layer for the Strav framework — mail, notifications, real-time broadcasting, and Server-Sent Events (SSE).

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
- src/mail/inbound/ — inbound webhook parsers (Postmark), loop-guard helper, canonical ParsedInboundMail type. IMAP + SendGrid/Mailgun/SES parsers pending.
- src/notification/ — NotificationManager, BaseNotification, channels (email, database, webhook, Discord)
- src/broadcast/ — BroadcastManager (server), Broadcast/Subscription (client)
- src/sse/ — SSEManager (server), SSEClient (client), parser utilities
- src/providers/ — MailProvider, NotificationProvider, BroadcastProvider

## Key Exports

### From root (@strav/signal)
- All mail, notification, broadcast, SSE, and provider exports

### From subpaths
- @strav/signal/mail — Mail functionality (mail helper, PendingMail, transports)
- @strav/signal/notification — Notification functionality (notify, BaseNotification, channels)
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
- Broadcasting: WebSocket testing requires running server
- SSE: Parser has comprehensive unit tests, integration tests use mock streams
