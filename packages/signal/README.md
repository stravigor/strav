# @strav/signal

Communication layer for the Strav framework — mail, notifications, and real-time broadcasting.

## Installation

```bash
bun add @strav/signal
```

## Features

- **Mail**: Send emails via multiple transports (SMTP, Resend, SendGrid, Mailgun, Alibaba Cloud)
- **Notifications**: Multi-channel notifications (email, database, webhook, Discord)
- **Broadcasting**: Real-time WebSocket broadcasting with channel authorization
- **Queue Integration**: Async mail and notification sending via @strav/queue
- **Template Support**: Uses @strav/view for email templates with CSS inlining

## Quick Start

### Mail

```typescript
import { mail } from '@strav/signal'

// Fluent API
await mail
  .to('user@example.com')
  .subject('Welcome!')
  .template('welcome', { name: 'Alice' })
  .send()

// Convenience API
await mail.send({
  to: 'user@example.com',
  subject: 'Welcome!',
  template: 'welcome',
  data: { name: 'Alice' }
})

// Queue mail for async sending
await mail
  .to('user@example.com')
  .subject('Newsletter')
  .template('newsletter', data)
  .queue()
```

### Notifications

```typescript
import { notify, BaseNotification } from '@strav/signal'

// Define a notification
class WelcomeNotification extends BaseNotification {
  via() {
    return ['email', 'database']
  }

  toMail(notifiable) {
    return {
      subject: 'Welcome!',
      template: 'welcome',
      data: { name: notifiable.name }
    }
  }

  toDatabase(notifiable) {
    return {
      type: 'welcome',
      message: `Welcome, ${notifiable.name}!`
    }
  }
}

// Send notification
await notify(user, new WelcomeNotification())

// Send to multiple users
await notify([user1, user2], new WelcomeNotification())
```

### Broadcasting

```typescript
import { broadcast } from '@strav/signal'

// Setup (in your app bootstrap)
broadcast.boot(router, {
  middleware: [session()]
})

// Define channels with authorization
broadcast.channel('notifications', async (ctx) => {
  return !!ctx.get('user')
})

broadcast.channel('chat/:id', async (ctx, { id }) => {
  const user = ctx.get('user')
  return user && await user.canAccessChat(id)
})

// Broadcast from server
broadcast.to('notifications').send('alert', { text: 'Hello' })
broadcast.to(`chat/${chatId}`).except(userId).send('message', data)

// Client-side (in browser)
import { Broadcast } from '@strav/signal/broadcast'

const broadcast = new Broadcast('/broadcast')
const subscription = broadcast.subscribe('notifications')
subscription.on('alert', (data) => console.log(data))
```

## Configuration

### Mail Configuration

```typescript
// config/mail.ts
export default {
  mail: {
    default: 'smtp',
    from: 'noreply@example.com',
    templatePrefix: 'mail',
    inlineCss: true,
    tailwind: false,

    transports: {
      smtp: {
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        auth: {
          user: 'username',
          pass: 'password'
        }
      },
      resend: {
        apiKey: 'your-api-key',
        from: 'onboarding@resend.dev'
      },
      sendgrid: {
        apiKey: 'your-api-key'
      },
      mailgun: {
        apiKey: 'your-api-key',
        domain: 'mg.example.com',
        region: 'us' // or 'eu'
      },
      alibaba: {
        accessKeyId: 'your-access-key',
        accessKeySecret: 'your-secret',
        accountName: 'noreply@example.com',
        region: 'cn-hangzhou'
      },
      log: {
        level: 'info'
      }
    }
  }
}
```

### Notification Configuration

```typescript
// config/notification.ts
export default {
  notification: {
    channels: {
      email: {
        from: 'notifications@example.com'
      },
      database: {
        table: 'notifications',
        markAsReadOnGet: true
      },
      webhook: {
        timeout: 5000,
        headers: {
          'X-Service': 'MyApp'
        }
      },
      discord: {
        username: 'MyApp Bot',
        avatarUrl: 'https://example.com/avatar.png'
      }
    }
  }
}
```

## Service Providers

Register providers in your app:

```typescript
import { MailProvider, NotificationProvider, BroadcastProvider } from '@strav/signal'

app.register([
  MailProvider,
  NotificationProvider,
  BroadcastProvider
])
```

## API Reference

### Mail

#### `mail.to(address: string | string[]): PendingMail`
Start building an email with fluent API.

#### `PendingMail` methods:
- `from(address: string)`: Set sender
- `cc(address: string | string[])`: Add CC recipients
- `bcc(address: string | string[])`: Add BCC recipients
- `replyTo(address: string)`: Set reply-to address
- `subject(value: string)`: Set subject
- `template(name: string, data?: Record<string, any>)`: Use template
- `html(value: string)`: Set raw HTML content
- `text(value: string)`: Set plain text content
- `attach(attachment: MailAttachment)`: Add attachment
- `send()`: Send immediately
- `queue(options?)`: Queue for async sending

#### `mail.send(options)`
Convenience method for sending with template.

#### `mail.raw(options)`
Send raw HTML/text without template.

#### `mail.registerQueueHandler()`
Register queue handler for async mail sending.

### Notifications

#### `notify(notifiable: Notifiable | Notifiable[], notification: BaseNotification)`
Send notification to one or more recipients.

#### `BaseNotification` abstract class
Override methods:
- `via(): string[]`: Channels to use
- `toMail(notifiable)`: Mail envelope
- `toDatabase(notifiable)`: Database payload
- `toWebhook(notifiable)`: Webhook envelope
- `toDiscord(notifiable)`: Discord envelope

#### `notifications` helper
- `markAsRead(userId, notificationIds)`: Mark as read
- `markAllAsRead(userId)`: Mark all as read
- `unread(userId, limit?)`: Get unread notifications
- `all(userId, limit?)`: Get all notifications
- `delete(userId, notificationIds)`: Delete notifications

### Broadcasting

#### `broadcast.boot(router: Router, options?: BootOptions)`
Initialize WebSocket endpoint.

#### `broadcast.channel(pattern: string, authorize?: AuthorizeCallback | ChannelConfig)`
Register channel with optional authorization.

#### `broadcast.to(channel: string): PendingBroadcast`
Start broadcasting to a channel.

#### `PendingBroadcast` methods:
- `except(clientId: string | string[])`: Exclude specific clients
- `send(event: string, data: any)`: Send to all matching clients

#### Client-side `Broadcast` class
- `constructor(url: string, options?: BroadcastOptions)`
- `subscribe(channel: string): Subscription`
- `unsubscribe(channel: string)`
- `disconnect()`

#### `Subscription` class
- `on(event: string, handler: Function)`: Listen for events
- `off(event: string, handler?: Function)`: Remove listener
- `send(event: string, data: any)`: Send to channel

## Mail Transports

### SMTP Transport
Standard SMTP configuration using nodemailer.

### Resend Transport
Integration with [Resend](https://resend.com) email API.

### SendGrid Transport
Integration with [SendGrid](https://sendgrid.com) email API.

### Mailgun Transport
Integration with [Mailgun](https://mailgun.com) email API.

### Alibaba Cloud Transport
Integration with Alibaba Cloud DirectMail service.

### Log Transport
Logs emails to console/file for development.

## Notification Channels

### Email Channel
Sends notifications via configured mail transport.

### Database Channel
Stores notifications in database for in-app display.

### Webhook Channel
Sends notifications to external webhook URLs.

### Discord Channel
Sends rich embed notifications to Discord webhooks.

## Advanced Features

### CSS Inlining
Automatically inline CSS for better email client compatibility:

```typescript
import { inlineCss } from '@strav/signal'

const inlined = await inlineCss(html, {
  enabled: true,
  tailwind: true // Load Tailwind styles
})
```

### Custom Transports
Create custom mail transports:

```typescript
import type { MailTransport } from '@strav/signal'

class CustomTransport implements MailTransport {
  async send(message: MailMessage): Promise<MailResult> {
    // Your implementation
    return { success: true, messageId: '...' }
  }
}
```

### Custom Notification Channels
Create custom notification channels:

```typescript
import type { NotificationChannel } from '@strav/signal'

class CustomChannel implements NotificationChannel {
  async send(notifiable: Notifiable, notification: BaseNotification): Promise<void> {
    // Your implementation
  }
}
```

## Testing

```bash
bun test
```

## License

MIT