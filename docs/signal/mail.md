# Mail

Transactional email with pluggable transports (SMTP, Resend, SendGrid, Mailgun, Alibaba DirectMail), `.strav` templates, automatic CSS inlining, and optional Tailwind support.

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
