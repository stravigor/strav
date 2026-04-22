# Mail

Transactional email with pluggable outbound transports (SMTP, Resend, SendGrid, Mailgun, Alibaba DirectMail), `.strav` templates, automatic CSS inlining, and optional Tailwind support. Inbound parsing is available via provider webhooks (Postmark, Mailgun) and IMAP polling (any mailbox, with scheduled-job integration); SendGrid / SES webhooks and OAuth2 IMAP (Gmail / M365) are pending — see [Inbound mail](#inbound-mail).

## Quick start

```typescript
import { mail } from '@strav/signal'

// Fluent builder
await mail.to('user@example.com')
  .subject('Welcome!')
  .template('welcome', { name: 'Alice' })
  .send()

// Convenience method
await mail.send({
  to: 'user@example.com',
  subject: 'Welcome!',
  template: 'welcome',
  data: { name: 'Alice' },
})

// Raw HTML (no template)
await mail.raw({
  to: 'user@example.com',
  subject: 'Alert',
  html: '<p>Something happened</p>',
  text: 'Something happened',
})
```

## Setup

### Using a service provider (recommended)

```typescript
import { MailProvider } from '@strav/signal'

app.use(new MailProvider())
```

The `MailProvider` registers `MailManager` as a singleton. It depends on the `config` provider.

To enable async sending via the queue, register the queue handler separately:

```typescript
import { mail } from '@strav/signal'

mail.registerQueueHandler()
```

### Manual setup

```typescript
import { MailManager } from '@strav/signal'
import { mail } from '@strav/signal'

app.singleton(MailManager)
app.resolve(MailManager)

// Register queue handler for async sending (optional)
mail.registerQueueHandler()
```

Create `config/mail.ts`:

```typescript
import { env } from '@strav/kernel'

export default {
  default: env('MAIL_DRIVER', 'log'),
  from: env('MAIL_FROM', 'noreply@localhost'),
  templatePrefix: env('MAIL_TEMPLATE_PREFIX', 'emails'),
  inlineCss: env.bool('MAIL_INLINE_CSS', true),
  tailwind: env.bool('MAIL_TAILWIND', false),

  smtp: {
    host: env('SMTP_HOST', '127.0.0.1'),
    port: env.int('SMTP_PORT', 587),
    secure: env.bool('SMTP_SECURE', false),
    auth: {
      user: env('SMTP_USER', ''),
      pass: env('SMTP_PASS', ''),
    },
  },

  resend: {
    apiKey: env('RESEND_API_KEY', ''),
  },

  sendgrid: {
    apiKey: env('SENDGRID_API_KEY', ''),
  },

  mailgun: {
    apiKey: env('MAILGUN_API_KEY', ''),
    domain: env('MAILGUN_DOMAIN', ''),
  },

  alibaba: {
    accessKeyId: env('ALIBABA_ACCESS_KEY_ID', ''),
    accessKeySecret: env('ALIBABA_ACCESS_KEY_SECRET', ''),
    accountName: env('ALIBABA_MAIL_ACCOUNT', ''),
  },

  log: {
    output: env('MAIL_LOG_OUTPUT', 'console'),
  },
}
```

## Fluent builder

`mail.to()` returns a `PendingMail` with chainable methods:

```typescript
await mail.to('user@example.com')           // required
  .from('support@app.com')                  // overrides config default
  .cc('manager@app.com')                    // string or string[]
  .bcc(['audit@app.com', 'log@app.com'])
  .replyTo('support@app.com')
  .subject('Your invoice is ready')
  .template('invoice', { amount, items })   // .strav template + data
  .attach({ filename: 'invoice.pdf', content: pdfBuffer, contentType: 'application/pdf' })
  .send()
```

### Template rendering

`.template(name, data)` renders a `.strav` template via the existing `ViewEngine`. The `name` is prefixed with the configured `templatePrefix` (default `'emails'`), so `.template('welcome', data)` renders `views/emails/welcome.strav`.

Templates support full `.strav` syntax — `@layout`, `@block`, `@include`, `@if`, `@each`, `{{ expr }}`, `{!! raw !!}`.

### Raw content

Use `.html()` and `.text()` instead of `.template()` for raw content:

```typescript
await mail.to('user@example.com')
  .subject('Quick note')
  .html('<p>Hello <strong>world</strong></p>')
  .text('Hello world')
  .send()
```

### Inspecting before send

Call `.build()` to get the finalized `MailMessage` without sending:

```typescript
const message = await mail.to('test@example.com')
  .subject('Test')
  .template('welcome', { name: 'Alice' })
  .build()

console.log(message.html) // rendered + CSS-inlined HTML
```

## Email templates

Templates live under `views/emails/` (or wherever `templatePrefix` points). They support layout inheritance for consistent branding.

### Email layout

```html
{{-- views/emails/layout.strav --}}
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; }
    .header { background: #4f46e5; color: white; padding: 20px; text-align: center; }
    .content { padding: 20px; }
    .footer { color: #6b7280; font-size: 12px; text-align: center; padding: 20px; }
    .btn { display: inline-block; background: #4f46e5; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header"><h1>{{ appName }}</h1></div>
    <div class="content">{!! content !!}</div>
    <div class="footer">&copy; {{ year }} {{ appName }}</div>
  </div>
</body>
</html>
```

### Email template

```html
{{-- views/emails/welcome.strav --}}
@layout('emails.layout')

@block('content')
<h2>Welcome, {{ name }}!</h2>
<p>Thanks for signing up. Your account is ready.</p>
<p><a class="btn" href="{{ verifyUrl }}">Verify Email</a></p>
@end
```

### Sending

```typescript
await mail.to(user.email)
  .subject('Welcome!')
  .template('welcome', {
    appName: 'My App',
    year: new Date().getFullYear(),
    name: user.name,
    verifyUrl: `https://app.example.com/verify/${token}`,
  })
  .send()
```

The `<style>` block in the layout is automatically inlined into `style=""` attributes on each element before sending, so the email renders correctly in all clients.

## CSS inlining

Most email clients strip `<style>` blocks and ignore external stylesheets. The mail module automatically inlines CSS using [juice](https://github.com/Automattic/juice) after template rendering.

This is enabled by default (`inlineCss: true` in config). The inliner:

- Converts `<style>` rules to inline `style=""` attributes
- Preserves `@media` queries (for responsive email)
- Preserves `@font-face` and `@keyframes`
- Applies `width`/`height` as HTML attributes (Outlook compatibility)
- Removes `<style>` tags after inlining

To disable:

```typescript
// config/mail.ts
export default {
  inlineCss: false,
  // ...
}
```

### Tailwind CSS support

If your email templates use Tailwind utility classes, enable Tailwind compilation:

```typescript
// config/mail.ts
export default {
  tailwind: true,
  // ...
}
```

When enabled, the mail module extracts class names from the rendered HTML, compiles them to CSS via Tailwind's programmatic API, injects a `<style>` block, then inlines everything with juice.

Tailwind is **not** a dependency of the framework — it is dynamically imported. Install it in your project if you want this feature:

```bash
bun add tailwindcss
```

If `tailwindcss` is not installed, the Tailwind step is silently skipped and only regular `<style>` blocks are inlined.

## Transports

### SMTP

Uses [nodemailer](https://nodemailer.com/) under the hood.

```bash
MAIL_DRIVER=smtp
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=apikey
SMTP_PASS=your-password
```

Works with any SMTP provider: Amazon SES, Postmark, Mailgun, Mailtrap, etc.

### Resend

Uses the [Resend HTTP API](https://resend.com/docs) via `fetch` — no SDK needed.

```bash
MAIL_DRIVER=resend
RESEND_API_KEY=re_...
```

### SendGrid

Uses the [SendGrid v3 Mail Send API](https://docs.sendgrid.com/api-reference/mail-send/mail-send) via `fetch` — no SDK needed.

```bash
MAIL_DRIVER=sendgrid
SENDGRID_API_KEY=SG....
```

### Mailgun

Uses the [Mailgun HTTP API](https://documentation.mailgun.com/docs/mailgun/api-reference/openapi-final/tag/Messages/) via `fetch` — no SDK needed.

```bash
MAIL_DRIVER=mailgun
MAILGUN_API_KEY=key-...
MAILGUN_DOMAIN=mg.example.com
```

For EU regions, add a `baseUrl` in your config:

```typescript
mailgun: {
  apiKey: env('MAILGUN_API_KEY', ''),
  domain: env('MAILGUN_DOMAIN', ''),
  baseUrl: 'https://api.eu.mailgun.net',
},
```

### Alibaba DirectMail

Uses the [Alibaba Cloud DirectMail API](https://www.alibabacloud.com/help/en/directmail/latest/SingleSendMail) via `fetch` with HMAC-SHA1 signature — no SDK needed.

```bash
MAIL_DRIVER=alibaba
ALIBABA_ACCESS_KEY_ID=LTAI...
ALIBABA_ACCESS_KEY_SECRET=...
ALIBABA_MAIL_ACCOUNT=noreply@example.com
```

For non-default regions, add a `region` in your config:

```typescript
alibaba: {
  accessKeyId: env('ALIBABA_ACCESS_KEY_ID', ''),
  accessKeySecret: env('ALIBABA_ACCESS_KEY_SECRET', ''),
  accountName: env('ALIBABA_MAIL_ACCOUNT', ''),
  region: 'ap-southeast-1',
},
```

> **Note:** The Alibaba DirectMail `SingleSendMail` API does not support CC, BCC, or attachments. Use the SMTP transport with Alibaba's SMTP endpoint if you need those features.

### Log

Logs email details to the console or a file. Useful for development and testing.

```bash
MAIL_DRIVER=log
MAIL_LOG_OUTPUT=console        # or a file path like 'logs/mail.log'
```

### Custom transport

Implement the `MailTransport` interface and swap it in:

```typescript
import type { MailTransport, MailMessage, MailResult } from '@strav/signal'
import { MailManager } from '@strav/signal'

class PostmarkTransport implements MailTransport {
  async send(message: MailMessage): Promise<MailResult> {
    const response = await fetch('https://api.postmarkapp.com/email', {
      method: 'POST',
      headers: {
        'X-Postmark-Server-Token': 'your-token',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        From: message.from,
        To: Array.isArray(message.to) ? message.to.join(',') : message.to,
        Subject: message.subject,
        HtmlBody: message.html,
        TextBody: message.text,
      }),
    })

    const data = await response.json() as { MessageID: string }
    return { messageId: data.MessageID }
  }
}

// In bootstrap
MailManager.useTransport(new PostmarkTransport())
```

## Inbound mail

Signal can parse inbound email delivered by provider webhooks into a canonical shape, so the same application code handles mail regardless of source. Each parser verifies the provider's authentication scheme (where one exists) and normalizes the payload to `ParsedInboundMail`.

**Available today:**

| Source | Parser / Driver | Authentication |
|---|---|---|
| Postmark Inbound | `PostmarkInboundParser` | Configure at HTTP layer — Postmark does not sign inbound webhooks |
| Mailgun Routes | `MailgunInboundParser` | HMAC-SHA256 over `timestamp + token` with webhook signing key |
| IMAP (any mailbox) | `ImapInboundDriver` + `mail.poll(...)` | Password auth (OAuth2 XOAUTH2 field available; refresh flow pending) |

**Pending:**

- SendGrid Inbound Parse, SES inbound (each with HMAC signature verification).
- OAuth2 refresh helpers for Gmail / Microsoft 365 IMAP (the driver accepts access tokens today; refresh is your responsibility).

### The canonical shape

Every inbound parser produces a `ParsedInboundMail`:

```typescript
interface ParsedInboundMail {
  from: { address: string; name?: string }
  to: { address: string; name?: string }[]
  cc: { address: string; name?: string }[]
  bcc: { address: string; name?: string }[]
  replyTo?: { address: string; name?: string }
  subject: string
  text?: string
  html?: string
  date?: Date
  /** Lowercased header name → value. */
  headers: Record<string, string>
  attachments: {
    filename: string
    contentType: string
    content: Buffer
    size: number
    cid?: string     // Content-ID for inline images, angle brackets stripped
  }[]
  /** RFC 5322 Message-ID, angle brackets stripped. Use for threading. */
  messageId?: string
  /** In-Reply-To header, angle brackets stripped. */
  inReplyTo?: string
  /** References header, parsed list, angle brackets stripped. */
  references: string[]
  /** True if auto-reply / vacation / bulk / list — do NOT auto-respond. */
  isAutoGenerated: boolean
  /** Provider's own identifier (e.g. Postmark's MessageID field). */
  providerMessageId?: string
}
```

Two identifier fields deserve attention:

- `messageId` is the RFC 5322 `Message-ID` header value — the id your reply threads against. Extracted from the message headers regardless of what the provider calls its own id.
- `providerMessageId` is the transport's internal id (e.g. Postmark's `MessageID`). Useful for debugging and delivery tracking — never for threading.

### Postmark webhook

```typescript
import { Router } from '@strav/http'
import { PostmarkInboundParser } from '@strav/signal'

const parser = new PostmarkInboundParser()

Router.post('/inbound/email/postmark', async ctx => {
  const mail = await parser.parse({
    body: await ctx.request.text(),
    headers: Object.fromEntries(ctx.request.headers.entries()),
  })

  if (mail.isAutoGenerated) {
    // Auto-reply, vacation responder, mailing list — accept but do not reply.
    return ctx.json({ ok: true, skipped: 'auto-generated' })
  }

  // Hand off to your application: ticket creation, threading lookup, etc.
  await processInboundMail(mail)

  return ctx.json({ ok: true })
})
```

**Authentication.** Postmark does **not** sign inbound webhooks with HMAC. Authenticate at the HTTP layer — either put Basic Auth credentials in the webhook URL you configure in the Postmark dashboard (`https://user:pass@your-host/inbound/email/postmark`) or restrict the route to Postmark's published [IP range](https://postmarkapp.com/support/article/800-ips-for-firewalls). Both is better than either.

**Return 2xx fast.** Return `200` from the route before doing any heavy lifting — Postmark retries on non-2xx responses. Hand the parsed message to a queue job rather than processing inline.

### Mailgun webhook

Mailgun POSTs multipart form data to your route URL and signs each request with HMAC-SHA256. Configure a Mailgun Route whose action is `forward("https://your-host/inbound/email/mailgun")`, grab the webhook signing key from the Mailgun dashboard, and wire it up:

```typescript
import { Router } from '@strav/http'
import { MailgunInboundParser } from '@strav/signal'

const parser = new MailgunInboundParser({
  webhookSigningKey: env('MAILGUN_WEBHOOK_SIGNING_KEY'),
  maxAgeSeconds: 300, // optional, defaults to 5 minutes
})

Router.post('/inbound/email/mailgun', async ctx => {
  const mail = await parser.parse({
    body: Buffer.from(await ctx.request.arrayBuffer()),
    headers: Object.fromEntries(ctx.request.headers.entries()),
  })

  if (mail.isAutoGenerated) {
    return ctx.json({ ok: true, skipped: 'auto-generated' })
  }
  await processInboundMail(mail)
  return ctx.json({ ok: true })
})
```

The parser:

- Verifies HMAC-SHA256 of `timestamp + token` with the webhook signing key in constant time. Throws `AuthenticationError` on mismatch.
- Rejects requests whose `timestamp` is more than `maxAgeSeconds` old (replay protection).
- Parses the multipart body via Bun's native `Response.formData()` — no extra multipart dependency.
- Extracts threading headers (Message-ID, In-Reply-To, References) from Mailgun's `message-headers` JSON field.
- Decodes all `attachment-N` fields into `Buffer`.

**Pass the raw body.** Signature verification hashes the exact bytes, so read the body as bytes (`arrayBuffer()` → `Buffer`), not as a parsed object. If your HTTP layer auto-parses multipart before you see it, the signature will fail.

**Webhook signing key, not API key.** Mailgun's webhook signing key is distinct from the sending API key. You'll find it under *Webhooks → HTTP webhook signing key* in the dashboard. Rotate both separately.

### IMAP polling

For mailboxes without a provider, poll over IMAP on a cron schedule. One poll cycle = one connect / SEARCH UNSEEN / fetch / parse / mark `\Seen` loop.

```typescript
import { mail } from '@strav/signal'

mail.poll(
  'mailbox:support',
  {
    host: 'imap.example.com',
    auth: { user: 'support@example.com', pass: env('IMAP_PASSWORD') },
  },
  async inbound => {
    if (inbound.isAutoGenerated) return
    await processInboundMail(inbound)
  }
).everyMinute().withoutOverlapping()
```

`mail.poll(name, config, handler)` returns a `Schedule`, so you chain the standard `@strav/queue` scheduler methods: `.everyMinute()`, `.everyFiveMinutes()`, `.cron('*/2 * * * *')`, `.withoutOverlapping()`, `.runImmediately()`.

#### Configuration

```typescript
interface ImapInboundConfig {
  host: string
  port?: number          // default 993 (IMAPS)
  secure?: boolean       // default true
  auth: { user: string; pass: string }
       | { user: string; accessToken: string }  // OAuth2 XOAUTH2
  mailbox?: string       // default 'INBOX'
  batchSize?: number     // max messages per cycle; default 50
  dryRun?: boolean       // parse but do not mark \Seen; default false
  tls?: { rejectUnauthorized?: boolean }
}
```

#### Error semantics per cycle

The driver is designed to make repeated polling safe:

- **Connection or auth failure** — `poll()` throws. The scheduler logs and retries on the next tick; nothing is marked `\Seen`, so no messages are lost.
- **Fetch fails for one message** — counted as `skipped`, left UNSEEN, next cycle retries it.
- **Handler throws for one message** — counted as `failed`, left UNSEEN, next cycle retries it. **Make handlers idempotent** (e.g., check whether a ticket already exists for this `messageId` before creating one).
- **Handler succeeds** — `\Seen` is set before moving to the next message.

`poll()` returns a `PollResult` with `{ processed, failed, skipped }` counts for logging and alerting.

#### OAuth2 (Gmail / M365)

Modern Google and Microsoft accounts refuse password auth. Pass a short-lived OAuth2 access token via `auth.accessToken` — the driver uses XOAUTH2:

```typescript
mail.poll('mailbox:gmail', {
  host: 'imap.gmail.com',
  auth: { user: 'support@company.com', accessToken: await getAccessToken() },
}, handleMail).everyMinute()
```

Refreshing the token before it expires is **your responsibility** until OAuth2 helpers ship. One pattern: wrap the config in a closure that refreshes via `@strav/oauth2` before each cycle, and pass an `ImapInboundDriver` built fresh each tick.

#### Using the driver directly

When you need to poll on demand (a CLI command, a warm-up job, tests), skip the scheduler helper and call the driver:

```typescript
import { ImapInboundDriver } from '@strav/signal'

const driver = new ImapInboundDriver(config)
const result = await driver.poll(async mail => { /* ... */ })
console.log(`processed=${result.processed} failed=${result.failed}`)
```

For unit tests, pass a custom client factory as the second constructor argument to swap in a fake IMAP client that implements `ImapClientLike` — the framework's own tests use this pattern to cover the full state machine without a real server.

### Threading replies

To thread an inbound reply back to the original outgoing message, match the `messageId`, `inReplyTo`, and `references` fields against the `Message-ID` values you recorded when sending:

```typescript
async function findOriginalThread(mail: ParsedInboundMail) {
  const candidates = [mail.inReplyTo, ...mail.references].filter(Boolean)
  if (candidates.length === 0) return null

  return db.sql`
    SELECT * FROM "outgoing_message"
    WHERE "message_id" = ANY(${candidates})
    ORDER BY "created_at" DESC
    LIMIT 1
  `
}
```

When sending, generate and persist the `Message-ID` you set on outgoing mail so inbound replies can find their parent — this is the threading primitive on both sides.

### Loop guard

The `isAutoGenerated` flag is `true` when the message looks like an auto-reply, mailing list, or bulk delivery. Applications that send auto-responders (first-contact acknowledgements, receipt confirmations) **must** check this flag before replying — otherwise two auto-responders talking to each other create an infinite mail loop.

The check follows RFC 3834 and common practice:

- `Auto-Submitted` header set to anything other than `no`.
- `Precedence: bulk | junk | list`.
- `X-Auto-Response-Suppress` header present.

You can use the same helper directly on arbitrary header bags:

```typescript
import { isAutoGeneratedMessage } from '@strav/signal'

if (isAutoGeneratedMessage(mail.headers)) {
  // Skip the auto-responder.
}
```

Set `Auto-Submitted: auto-replied` on your own outbound auto-responder messages so other servers honor the same contract.

### Custom parsers

For a provider we don't ship, implement `InboundWebhookParser`:

```typescript
import type {
  InboundWebhookInput,
  InboundWebhookParser,
  ParsedInboundMail,
} from '@strav/signal'
import { isAutoGeneratedMessage } from '@strav/signal'

class CustomProviderParser implements InboundWebhookParser {
  async parse(input: InboundWebhookInput): Promise<ParsedInboundMail> {
    // 1. Verify provider signature from input.headers against input.body (HMAC etc.)
    // 2. Parse input.body (JSON, multipart, etc.)
    // 3. Normalize to ParsedInboundMail
    // 4. Extract messageId / inReplyTo / references from the RFC 5322 headers
    // 5. Set isAutoGenerated: isAutoGeneratedMessage(headers)
    throw new Error('not implemented')
  }
}
```

Keep parsers free of `@strav/http` types — a parser should be callable from an HTTP route, a queue job (for IMAP bytes once that ships), or a unit test, so the interface takes raw bytes and headers rather than a request object.

## Queue integration

Use `.queue()` instead of `.send()` to push the email onto the job queue for async delivery:

```typescript
await mail.to(user.email)
  .subject('Weekly Report')
  .template('report', { stats })
  .queue()

// With options
await mail.to(user.email)
  .subject('Reminder')
  .template('reminder', { task })
  .queue({ queue: 'emails', delay: 60_000 })
```

The template is rendered and CSS is inlined at enqueue time — the queue worker only needs to call the transport's `send()` method.

Register the queue handler in your bootstrap:

```typescript
import { mail } from '@strav/signal'

mail.registerQueueHandler()
```

For multi-channel delivery (email + in-app + webhook + Discord) triggered by domain events, see the [Notification module](./notification.md) which reuses the Mail module for its email channel.

## Attachments

```typescript
await mail.to('user@example.com')
  .subject('Your report')
  .template('report', data)
  .attach({
    filename: 'report.pdf',
    content: pdfBuffer,
    contentType: 'application/pdf',
  })
  .send()
```

For inline images (CID), set the `cid` field:

```typescript
await mail.to('user@example.com')
  .subject('Photo')
  .html('<p>See this: <img src="cid:photo123"></p>')
  .attach({
    filename: 'photo.jpg',
    content: imageBuffer,
    contentType: 'image/jpeg',
    cid: 'photo123',
  })
  .send()
```

## Testing

Swap in a mock transport with `MailManager.useTransport()`:

```typescript
import { test, expect, beforeEach } from 'bun:test'
import { MailManager } from '@strav/signal'
import { mail } from '@strav/signal'
import type { MailTransport, MailMessage, MailResult } from '@strav/signal'

class MockTransport implements MailTransport {
  sent: MailMessage[] = []

  async send(message: MailMessage): Promise<MailResult> {
    this.sent.push(message)
    return { messageId: `mock-${this.sent.length}` }
  }
}

let mockTransport: MockTransport

beforeEach(() => {
  mockTransport = new MockTransport()
  MailManager.useTransport(mockTransport)
})

test('sends welcome email', async () => {
  await mail.to('user@example.com')
    .subject('Welcome')
    .html('<h1>Hi</h1>')
    .send()

  expect(mockTransport.sent).toHaveLength(1)
  expect(mockTransport.sent[0].subject).toBe('Welcome')
})
```

## Controller example

```typescript
import { mail } from '@strav/signal'

export default class InvitationController {
  async create(ctx: Context) {
    const [session, user, org] = ctx.get<Session, User, Organization>('session', 'user', 'organization')
    const { email, role } = await ctx.body<{ email: string; role: string }>()

    const token = randomHex(32)

    await BaseModel.db.sql`
      INSERT INTO "invitation" ("organization_id", "email", "role", "token", "invited_by")
      VALUES (${org.id}, ${email}, ${role}, ${token}, ${user.id})
    `

    await mail.to(email)
      .subject(`You're invited to ${org.name}`)
      .template('invitation', {
        appName: 'My App',
        year: new Date().getFullYear(),
        orgName: org.name,
        inviterName: user.name,
        acceptUrl: `https://app.example.com/invite/${token}`,
      })
      .send()

    session.flash('success', `Invitation sent to ${email}.`)
    return ctx.redirect(`/org/${org.slug}/members`)
  }
}
```
