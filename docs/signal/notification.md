# Notification

Multi-channel notifications (email, in-app, webhook, Discord) with event integration, queue support, and pluggable custom channels.

## Quick start

```typescript
import { notify } from '@strav/signal'

// Send to a single recipient
await notify(user, new TaskAssignedNotification(task, assigner))

// Send to multiple recipients
await notify([user1, user2], new InvoicePaidNotification(invoice))
```

## Setup

### Using a service provider (recommended)

```typescript
import { NotificationProvider } from '@strav/signal'

app.use(new NotificationProvider())
```

The `NotificationProvider` registers `NotificationManager` as a singleton and creates the `_strav_notifications` table automatically. It depends on the `database` provider.

Options:

| Option | Default | Description |
|--------|---------|-------------|
| `ensureTable` | `true` | Auto-create the notifications table |

To enable async delivery via the queue, register the queue handler separately:

```typescript
import { notifications } from '@strav/signal'

notifications.registerQueueHandler()
```

### Manual setup

```typescript
import { NotificationManager } from '@strav/signal'
import { notifications } from '@strav/signal'

app.singleton(NotificationManager)
app.resolve(NotificationManager)
await NotificationManager.ensureTable()

// Register queue handler for async delivery (optional)
notifications.registerQueueHandler()
```

Create `config/notification.ts`:

```typescript
import { env } from '@strav/kernel'

export default {
  // Default channels when a notification does not specify via()
  channels: ['database'],

  // Queue name for async notifications
  queue: env('NOTIFICATION_QUEUE', 'default'),

  // Named webhook endpoints
  webhooks: {
    // default: {
    //   url: env('WEBHOOK_URL', ''),
    //   headers: { 'X-Secret': env('WEBHOOK_SECRET', '') },
    // },
  },

  // Named Discord webhook URLs
  discord: {
    // default: env('DISCORD_WEBHOOK_URL', ''),
  },
}
```

## Defining notifications

Extend `BaseNotification` and implement `via()` plus a `toXxx()` method for each channel:

```typescript
import { BaseNotification } from '@strav/signal'
import type { Notifiable, MailEnvelope, DatabaseEnvelope, DiscordEnvelope } from '@strav/signal'

export class TaskAssignedNotification extends BaseNotification {
  constructor(private task: Task, private assigner: User) {
    super()
  }

  via(notifiable: Notifiable): string[] {
    return ['email', 'database', 'discord']
  }

  toEmail(notifiable: Notifiable): MailEnvelope {
    return {
      subject: `You've been assigned: ${this.task.title}`,
      template: 'task-assigned',
      templateData: {
        taskTitle: this.task.title,
        assignerName: this.assigner.name,
      },
    }
  }

  toDatabase(notifiable: Notifiable): DatabaseEnvelope {
    return {
      type: 'task.assigned',
      data: {
        taskId: this.task.id,
        taskTitle: this.task.title,
        assignerId: this.assigner.id,
        assignerName: this.assigner.name,
      },
    }
  }

  toDiscord(): DiscordEnvelope {
    return {
      embeds: [{
        title: 'Task Assigned',
        description: `**${this.task.title}** was assigned to a team member`,
        color: 0x5865F2,
        fields: [
          { name: 'Assigned by', value: this.assigner.name, inline: true },
        ],
      }],
    }
  }

  shouldQueue() { return true }
}
```

## Notifiable interface

Any model that can receive notifications must implement the `Notifiable` interface:

```typescript
import type { Notifiable } from '@strav/signal'

class User extends BaseModel implements Notifiable {
  notifiableId() { return this.id }
  notifiableType() { return 'user' }
  routeNotificationForEmail() { return this.email }
  routeNotificationForDiscord() { return null }  // no per-user Discord
  routeNotificationForWebhook() { return null }
}
```

Only `notifiableId()` and `notifiableType()` are required. The `routeNotificationForXxx()` methods are optional and used by channels to resolve delivery addresses.

## Channels

### Email

Delegates to the existing Mail module. Reads the address from `notifiable.routeNotificationForEmail()` and builds a `PendingMail` from the `MailEnvelope`.

```typescript
toEmail(notifiable: Notifiable): MailEnvelope {
  return {
    subject: 'Your invoice is ready',
    template: 'invoice-ready',      // renders views/emails/invoice-ready.strav
    templateData: { amount, items },
    from: 'billing@app.com',        // overrides config default
    cc: 'accounting@app.com',
  }
}
```

Templates, CSS inlining, and Tailwind support all work exactly as documented in the [Mail guide](./mail.md).

### Database (in-app)

Stores notifications in `_strav_notifications` for in-app notification features (unread badges, notification feeds).

```typescript
toDatabase(notifiable: Notifiable): DatabaseEnvelope {
  return {
    type: 'invoice.paid',
    data: { invoiceId: invoice.id, amount: invoice.total },
  }
}
```

### Webhook

Sends an HTTP POST to a webhook URL. URL resolution:
1. `WebhookEnvelope.url` (per-notification override)
2. `notifiable.routeNotificationForWebhook()` (per-recipient)
3. Config `webhooks.default.url`

```typescript
toWebhook(notifiable: Notifiable): WebhookEnvelope {
  return {
    payload: { event: 'invoice.paid', invoiceId: invoice.id, amount: invoice.total },
    headers: { 'X-Signature': sign(invoice) },
    // url: 'https://...',  // optional override
  }
}
```

### Discord

Sends to a Discord webhook URL. Supports plain text content and [embeds](https://discord.com/developers/docs/resources/message#embed-object). URL resolution:
1. `DiscordEnvelope.url` (per-notification override)
2. `notifiable.routeNotificationForDiscord()` (per-recipient)
3. Config `discord.default`

```typescript
toDiscord(): DiscordEnvelope {
  return {
    content: 'New payment received!',
    embeds: [{
      title: 'Invoice Paid',
      description: `Invoice #${invoice.number} — $${invoice.total}`,
      color: 0x00D26A,
      fields: [
        { name: 'Customer', value: customer.name, inline: true },
        { name: 'Amount', value: `$${invoice.total}`, inline: true },
      ],
      timestamp: new Date().toISOString(),
    }],
  }
}
```

### Custom channel

Implement the `NotificationChannel` interface and register it:

```typescript
import type { NotificationChannel, Notifiable, NotificationPayload } from '@strav/signal'
import { NotificationManager } from '@strav/signal'

class SlackChannel implements NotificationChannel {
  readonly name = 'slack'

  async send(notifiable: Notifiable, payload: NotificationPayload): Promise<void> {
    const data = (payload as any).slack
    if (!data) return

    await fetch('https://hooks.slack.com/services/...', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: data.text, blocks: data.blocks }),
    })
  }
}

// In bootstrap
NotificationManager.useChannel(new SlackChannel())
```

Then in your notification class, include `'slack'` in `via()` and add a `toSlack()` method (the channel reads it from the payload).

## Sending notifications

### Direct send

```typescript
import { notify } from '@strav/signal'

await notify(user, new WelcomeNotification())
await notify([user1, user2, user3], new ProjectInviteNotification(project))
```

### Queue support

Override `shouldQueue()` in your notification to deliver asynchronously:

```typescript
class WelcomeNotification extends BaseNotification {
  shouldQueue() { return true }

  queueOptions() {
    return { queue: 'notifications', delay: 5000, attempts: 3 }
  }

  // ...channels
}
```

When queued, routing information (email address, webhook URL, etc.) is resolved at enqueue time and serialized with the job. The queue worker reconstructs a minimal notifiable proxy and delivers through each channel.

Register the queue handler in bootstrap:

```typescript
import { notifications } from '@strav/signal'

notifications.registerQueueHandler()
```

## Event integration

Wire domain events to notifications using `NotificationManager.on()`:

```typescript
import { NotificationManager, notifications } from '@strav/signal'
import { TaskAssignedNotification } from '../app/notifications/task_assigned_notification'
import { InvoicePaidNotification } from '../app/notifications/invoice_paid_notification'

// Map events to notifications
NotificationManager.on('task.assigned', {
  create: ({ task, assigner }) => new TaskAssignedNotification(task, assigner),
  recipients: ({ assignee }) => assignee,  // must implement Notifiable
})

NotificationManager.on('invoice.paid', {
  create: ({ invoice }) => new InvoicePaidNotification(invoice),
  recipients: async ({ invoice }) => {
    // Async recipient resolution
    const User = (await import('../app/models/user')).default
    return User.find(invoice.userId)
  },
})

// Install Emitter listeners
notifications.wireEvents()
```

After `wireEvents()`, when `Emitter.emit('task.assigned', payload)` fires from a service, the corresponding notification is automatically created and sent to the resolved recipients.

## In-app notifications

The `notifications` helper provides query methods for the database channel:

```typescript
import { notifications } from '@strav/signal'

// Fetch notifications
const all    = await notifications.all('user', userId)
const unread = await notifications.unread('user', userId)
const count  = await notifications.unreadCount('user', userId)

// Mark as read
await notifications.markAsRead(notificationId)
await notifications.markAllAsRead('user', userId)

// Delete
await notifications.delete(notificationId)
await notifications.deleteAll('user', userId)
```

### Controller example

```typescript
export default class NotificationController {
  async index(ctx: Context) {
    const [session, user] = ctx.get<Session, User>('session', 'user')

    const items = await notifications.all('user', user.id)
    const unreadCount = await notifications.unreadCount('user', user.id)

    return ctx.view('notifications.index', { items, unreadCount })
  }

  async markRead(ctx: Context) {
    await notifications.markAsRead(ctx.params.id!)
    return new Response(null, { status: 204 })
  }

  async markAllRead(ctx: Context) {
    const [session, user] = ctx.get<Session, User>('session', 'user')
    await notifications.markAllAsRead('user', user.id)
    return ctx.redirect('/notifications')
  }
}
```

### API endpoint

```typescript
export default class NotificationApiController {
  async index(ctx: Context) {
    const [session, user] = ctx.get<Session, User>('session', 'user')
    const items = await notifications.unread('user', user.id)
    return Response.json(items)
  }

  async unreadCount(ctx: Context) {
    const [session, user] = ctx.get<Session, User>('session', 'user')
    const count = await notifications.unreadCount('user', user.id)
    return Response.json({ count })
  }
}
```

## Database table

`NotificationManager.ensureTable()` creates `_strav_notifications`:

| Column | Type | Notes |
|--------|------|-------|
| id | UUID | PK, auto-generated |
| notifiable_type | VARCHAR(255) | e.g. `'user'`, `'organization'` |
| notifiable_id | VARCHAR(255) | Notifiable's ID |
| type | VARCHAR(255) | Category string, e.g. `'task.assigned'` |
| data | JSONB | Structured notification data |
| read_at | TIMESTAMPTZ | NULL = unread |
| created_at | TIMESTAMPTZ | Auto-set |

Indexes:
- `(notifiable_type, notifiable_id, created_at DESC)` — main query index
- `(notifiable_type, notifiable_id) WHERE read_at IS NULL` — partial index for unread queries

## Testing

Swap in a mock channel or spy on existing channels:

```typescript
import { test, expect, beforeEach } from 'bun:test'
import { NotificationManager } from '@strav/signal'
import { notify } from '@strav/signal'
import type { NotificationChannel, Notifiable, NotificationPayload } from '@strav/signal'

class MockChannel implements NotificationChannel {
  readonly name = 'mock'
  sent: { notifiable: Notifiable; payload: NotificationPayload }[] = []

  async send(notifiable: Notifiable, payload: NotificationPayload): Promise<void> {
    this.sent.push({ notifiable, payload })
  }
}

let mockChannel: MockChannel

beforeEach(() => {
  mockChannel = new MockChannel()
  NotificationManager.useChannel(mockChannel)
})

test('sends notification via mock channel', async () => {
  class TestNotification extends BaseNotification {
    via() { return ['mock'] }
  }

  const user: Notifiable = {
    notifiableId: () => 1,
    notifiableType: () => 'user',
  }

  await notify(user, new TestNotification())

  expect(mockChannel.sent).toHaveLength(1)
  expect(mockChannel.sent[0].notifiable.notifiableId()).toBe(1)
})
```
