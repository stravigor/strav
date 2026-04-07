# Broadcast

Channel-based real-time broadcasting over WebSocket. One connection per client, multiplexed channels, pattern-based authorization, auto-reconnect.

## Setup

### Using a service provider (recommended)

```typescript
import { BroadcastProvider } from '@strav/signal'
import { session } from '@strav/http'

app.use(new BroadcastProvider({
  middleware: [session()],
  pingInterval: 30_000,
  path: '/_broadcast',
}))
```

The `BroadcastProvider` calls `BroadcastManager.boot()` with the router and shuts down connections on application shutdown.

### Manual setup

```typescript
import { broadcast } from '@strav/signal'

broadcast.boot(router, {
  middleware: [session()],   // optional — run middleware on each WS connection
  pingInterval: 30_000,      // keepalive interval in ms (default: 30s, 0 to disable)
  path: '/_broadcast',       // WS endpoint path (default: /_broadcast)
})
```

## Channels

Define channels to control which topics clients can subscribe to. Channel patterns use the same `:param` syntax as routes.

```typescript
import { broadcast } from '@strav/signal'
```

### Public channel

Anyone can subscribe — no authorization:

```typescript
broadcast.channel('announcements')
```

### Authorized channel

The callback receives the connection's `Context` (with session/user from middleware) and the extracted params. Return `true` to allow, `false` to deny:

```typescript
broadcast.channel('chats/:id', async (ctx, { id }) => {
  const user = ctx.get('user')
  return !!user
})
```

### Channel with message handlers

For bidirectional communication, define message handlers that receive events from clients:

```typescript
broadcast.channel('chat/:id', {
  authorize: async (ctx, { id }) => !!ctx.get('user'),
  messages: {
    async send(ctx, { id }, data) {
      const user = ctx.get('user')
      await Message.create({ chatId: id, text: data.text, userId: user.id })
      broadcast.to(`chat/${id}`).send('new_message', { text: data.text, userId: user.id })
    },
    typing(ctx, { id }, data) {
      broadcast.to(`chat/${id}`).except(ctx.clientId).send('typing', data)
    }
  }
})
```

Each handler receives:
- `ctx` — the connection's Context (with `ctx.clientId` set to the sender's ID)
- `params` — extracted route parameters from the channel pattern
- `data` — the payload sent by the client

## Broadcasting

Send events to channel subscribers from anywhere — controllers, services, event listeners:

```typescript
import { broadcast } from '@strav/signal'

// Broadcast to all subscribers
broadcast.to('announcements').send('news', { title: 'v2 released!' })

// Broadcast to a dynamic channel
broadcast.to(`chats/${chatId}`).send('message', { text, userId })

// Exclude a specific client (e.g. the sender)
broadcast.to(`chats/${chatId}`).except(senderId).send('message', data)
```

Broadcasting to a channel with no subscribers is a no-op.

## Client

The browser client manages a single WebSocket connection with automatic reconnection and multiplexed channel subscriptions.

```typescript
import { Broadcast } from '@strav/signal/broadcast'
```

### Connect

```typescript
const bc = new Broadcast()  // auto-detects ws(s)://host/_broadcast
```

Or with explicit options:

```typescript
const bc = new Broadcast({
  url: 'wss://api.example.com/_broadcast',
  maxReconnectAttempts: 10,  // default: Infinity
})
```

### Subscribe to a channel

```typescript
const chat = bc.subscribe('chat/1')

chat.on('new_message', (data) => {
  console.log(data.text)
})

chat.on('typing', (data) => {
  showTypingIndicator(data.userId)
})
```

The `on` method returns a cleanup function:

```typescript
const stop = chat.on('new_message', handler)
stop()  // remove this specific listener
```

### Send messages to the server

For channels with message handlers:

```typescript
chat.send('send', { text: 'Hello!' })
chat.send('typing', { active: true })
```

### Unsubscribe

```typescript
chat.leave()
```

### Connection lifecycle

```typescript
bc.on('connected', () => {
  console.log('Online')
})

bc.on('disconnected', () => {
  console.log('Offline')
})

bc.on('reconnecting', (attempt) => {
  console.log(`Reconnecting... attempt ${attempt}`)
})

bc.on('subscribed', (channel) => {
  console.log(`Subscribed to ${channel}`)
})

bc.on('error', ({ channel, reason }) => {
  console.log(`Subscription to ${channel} denied: ${reason}`)
})
```

### Client ID

Each connection receives a unique ID from the server. Available after the first `connected` event:

```typescript
bc.clientId  // string | null
```

### Close

```typescript
bc.close()  // closes connection, no reconnect
```

## Reconnection

The client reconnects automatically with exponential backoff (1s, 2s, 4s, ... up to 30s). On reconnect, all active subscriptions are re-established automatically.

## Wire protocol

All messages are JSON over a single WebSocket. Short keys minimize overhead:

```
Client → Server:
  { "t": "sub",   "c": "chat/1" }                            subscribe
  { "t": "unsub", "c": "chat/1" }                            unsubscribe
  { "t": "msg",   "c": "chat/1", "e": "send", "d": {...} }  channel message

Server → Client:
  { "t": "welcome", "id": "uuid" }                           connection established
  { "t": "ok",   "c": "chat/1" }                             subscription confirmed
  { "t": "err",  "c": "chat/1", "r": "unauthorized" }       subscription denied
  { "t": "msg",  "c": "chat/1", "e": "message", "d": {...} } broadcast event
  { "t": "ping" }                                             keepalive
```

## Introspection

```typescript
broadcast.clientCount                   // number of active connections
broadcast.subscriberCount('chat/1')     // subscribers on a specific channel
```

## Integration with events

Bridge application events to broadcast channels:

```typescript
import { Emitter } from '@strav/kernel'
import { broadcast } from '@strav/signal'

Emitter.on<{ task: Task }>('task.created', ({ task }) => {
  broadcast.to(`projects/${task.projectId}/tasks`).send('created', task)
})
```

## Full example

```typescript
// index.ts
import { broadcast } from '@strav/signal'

broadcast.boot(router, { middleware: [session()] })

broadcast.channel('notifications', (ctx) => !!ctx.get('user'))

broadcast.channel('chat/:id', {
  authorize: (ctx, { id }) => !!ctx.get('user'),
  messages: {
    async send(ctx, { id }, data) {
      broadcast.to(`chat/${id}`).send('message', {
        text: data.text,
        userId: ctx.get('user').id,
      })
    }
  }
})
```

```typescript
// client
import { Broadcast } from '@strav/signal/broadcast'

const bc = new Broadcast()
const chat = bc.subscribe('chat/1')

chat.on('message', (data) => {
  addMessage(data.text, data.userId)
})

chat.send('send', { text: 'Hello!' })
```
