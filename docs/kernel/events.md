# Events

The events module provides an in-memory publish/subscribe event bus with async support. No DI, no database, no configuration required.

## Quick start

```typescript
import { Emitter } from '@strav/kernel'

// Listen
Emitter.on('user.registered', async ({ user }) => {
  await sendWelcomeEmail(user)
})

// Emit — awaits all listeners in parallel
await Emitter.emit('user.registered', { user })
```

## Listening

### on — persistent listener

```typescript
Emitter.on('order.placed', async (payload) => {
  console.log('Order placed:', payload.orderId)
})
```

### once — single-use listener

Automatically removed after its first invocation:

```typescript
Emitter.once('app.ready', () => {
  console.log('App is ready')
})
```

### off — remove a listener

```typescript
const listener = async (payload) => { /* ... */ }

Emitter.on('user.deleted', listener)
Emitter.off('user.deleted', listener)
```

### removeAllListeners

```typescript
// Remove all listeners for a specific event
Emitter.removeAllListeners('user.registered')

// Remove all listeners for all events
Emitter.removeAllListeners()
```

## Emitting

```typescript
await Emitter.emit('order.placed', { orderId: 42, total: 99.95 })
```

`emit()` is async — it runs all listeners in parallel via `Promise.allSettled` and awaits their completion. If no listeners are registered, it returns immediately.

## Typed payloads

Use generics to type the payload:

```typescript
interface UserRegistered {
  user: User
  invitedBy?: number
}

Emitter.on<UserRegistered>('user.registered', async ({ user, invitedBy }) => {
  // user and invitedBy are typed
})

await Emitter.emit<UserRegistered>('user.registered', { user })
```

## Error isolation

If a listener throws, the other listeners still run to completion. After all listeners settle, the first error is re-thrown:

```typescript
Emitter.on('process', async () => {
  throw new Error('listener A failed')
})

Emitter.on('process', async () => {
  // This still runs, even though listener A threw
  console.log('listener B succeeded')
})

await Emitter.emit('process', {})
// throws: 'listener A failed' — but listener B already executed
```

This makes it safe to register independent side-effects without worrying about one breaking the others.

## Introspection

```typescript
Emitter.listenerCount('user.registered') // 3
```

## Connecting events to the queue

Use `Queue.listener()` to bridge events to background jobs:

```typescript
import { Emitter } from '@strav/kernel'
import { Queue } from '@strav/queue'

// When a user registers, push a background job
Emitter.on('user.registered', Queue.listener('send-welcome-email'))

// The job handler runs later, in a worker process
Queue.handle('send-welcome-email', async (payload) => {
  await mailer.send(payload.user.email, 'Welcome!')
})
```

This is the recommended pattern for offloading slow work (emails, webhooks, image processing) from the request cycle.

## Connecting events to notifications

Use `NotificationManager.on()` to declaratively map events to multi-channel notifications:

```typescript
import { NotificationManager, notifications } from '@strav/signal'

NotificationManager.on('task.assigned', {
  create: ({ task, assigner }) => new TaskAssignedNotification(task, assigner),
  recipients: ({ assignee }) => assignee,
})

notifications.wireEvents()
```

When `task.assigned` fires, the notification is automatically created and delivered to the resolved recipients through all configured channels (email, in-app, webhook, Discord, etc.).

See the [Notification guide](./notification.md) for full details.

## Testing

Call `Emitter.reset()` in your test teardown to clear all listeners:

```typescript
import { afterEach } from 'bun:test'
import { Emitter } from '@strav/kernel'

afterEach(() => {
  Emitter.reset()
})
```
