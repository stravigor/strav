# Server-Sent Events (SSE)

One-way server-to-client streaming over HTTP. Simpler than WebSockets, automatic reconnection, text-based protocol, perfect for notifications and live feeds.

## Overview

SSE provides real-time server push capabilities using standard HTTP. Unlike WebSockets which require a protocol upgrade, SSE works over regular HTTP/HTTPS connections, making it simpler to deploy and more compatible with existing infrastructure.

**When to use SSE:**
- Server-to-client only communication (notifications, live feeds)
- Progress indicators and streaming updates
- Simple real-time requirements without bidirectional messaging
- Better HTTP/2 compatibility and proxy/firewall traversal

**When to use WebSockets (broadcast module):**
- Bidirectional communication needed
- Binary data transmission
- Lower latency requirements
- Complex real-time interactions (chat, gaming)

## Setup

### Using a service provider (recommended)

```typescript
import { SSEProvider } from '@strav/signal'
import { session } from '@strav/http'

app.use(new SSEProvider({
  middleware: [session()],
  defaultHeartbeat: 30_000,
  path: '/_sse',
  cors: ['https://app.example.com']
}))
```

The `SSEProvider` calls `SSEManager.boot()` with the router and manages connection cleanup on application shutdown.

### Manual setup

```typescript
import { sse } from '@strav/signal'

sse.boot(router, {
  middleware: [session()],      // optional — run middleware on each SSE connection
  defaultHeartbeat: 30_000,     // heartbeat interval in ms (default: 30s, 0 to disable)
  path: '/_sse',                // SSE endpoint path (default: /_sse)
  cors: '*'                     // CORS origins (default: *)
})
```

## Channels

Define channels to control which event streams clients can subscribe to. Channel patterns use the same `:param` syntax as routes.

```typescript
import { sse } from '@strav/signal'
```

### Public channel

Anyone can subscribe — no authorization:

```typescript
sse.channel('notifications')
sse.channel('system-status')
```

### Authorized channel

Return `true` to allow subscription:

```typescript
// User-specific channel
sse.channel('users/:id', async (ctx, params) => {
  const user = ctx.get('user')
  return user?.id === params.id
})

// Role-based channel
sse.channel('admin/*path', async (ctx) => {
  const user = ctx.get('user')
  return user?.role === 'admin'
})
```

### Channel with custom heartbeat

Override the default heartbeat interval for specific channels:

```typescript
sse.channel('live-data', {
  authorize: async (ctx) => !!ctx.get('user'),
  heartbeat: 5000  // 5 second heartbeat for this channel
})
```

## Server-Side Broadcasting

### Send events to channels

```typescript
import { sse } from '@strav/signal'

// Send typed event with data
sse.to('notifications').send('alert', {
  level: 'info',
  message: 'System update completed'
})

// Send data without event type (client receives as 'message' event)
sse.to('metrics').data({
  cpu: 0.75,
  memory: 0.82,
  timestamp: Date.now()
})

// Exclude specific clients
sse.to('chat').except(senderId).send('new-message', {
  from: senderName,
  text: messageText
})
```

### Monitor connections

```typescript
// Get active connection count
console.log(`Active SSE connections: ${sse.connectionCount}`)

// Get subscribers for a specific channel
console.log(`Users online: ${sse.subscriberCount('users/123')}`)

// List all active channels
console.log(`Active channels: ${sse.activeChannels.join(', ')}`)
```

## Client-Side (Browser)

### Basic setup

```typescript
import { SSEClient } from '@strav/signal/sse'

const client = new SSEClient({
  url: '/_sse',                    // auto-detected if not provided
  reconnectDelay: 1000,            // initial reconnect delay (default: 1s)
  maxReconnectDelay: 30000,        // max reconnect delay (default: 30s)
  maxReconnectAttempts: Infinity,  // max attempts (default: unlimited)
  reconnectMultiplier: 1.5         // backoff multiplier (default: 1.5)
})

// Monitor connection state
client.on('connected', () => console.log('SSE connected'))
client.on('disconnected', () => console.log('SSE disconnected'))
client.on('error', (err) => console.error('SSE error:', err))
client.on('reconnecting', ({ attempt, delay }) => {
  console.log(`Reconnecting... attempt ${attempt} in ${delay}ms`)
})
```

### Subscribe to channels

```typescript
// Subscribe to a channel
const notifications = client.subscribe('notifications')

// Listen for specific events
notifications.on('alert', (data) => {
  console.log(`Alert: ${data.level} - ${data.message}`)
})

// Listen for all messages (no event type)
notifications.on('message', (data) => {
  console.log('Received:', data)
})

// Handle channel errors
notifications.on('error', (err) => {
  console.error('Channel error:', err)
})

// Unsubscribe
notifications.close()
```

### Multiple subscriptions

```typescript
// Subscribe to multiple channels
const userChannel = client.subscribe(`users/${userId}`)
const teamChannel = client.subscribe(`teams/${teamId}`)

userChannel.on('status-change', (data) => {
  updateUserStatus(data.status)
})

teamChannel.on('member-joined', (data) => {
  addTeamMember(data.member)
})

// Clean up all subscriptions
client.close()
```

## HTTP Integration

Use `ctx.sse()` in your route handlers to stream SSE directly:

### With async generator

```typescript
router.get('/progress/:taskId', async (ctx) => {
  const taskId = ctx.params.taskId

  return ctx.sse(async function* () {
    for (let i = 0; i <= 100; i += 10) {
      yield {
        event: 'progress',
        data: { percent: i, taskId }
      }
      await sleep(1000)
    }
    yield {
      event: 'complete',
      data: { taskId, result: 'Success' }
    }
  })
})
```

### With ReadableStream

```typescript
router.get('/live-metrics', async (ctx) => {
  const stream = new ReadableStream({
    async start(controller) {
      const interval = setInterval(() => {
        controller.enqueue({
          event: 'metrics',
          data: {
            cpu: Math.random(),
            memory: Math.random(),
            timestamp: Date.now()
          }
        })
      }, 1000)

      // Cleanup on disconnect
      setTimeout(() => {
        clearInterval(interval)
        controller.close()
      }, 60000) // Close after 1 minute
    }
  })

  return ctx.sse(stream)
})
```

### Helper utilities

```typescript
import { createSSEStream, createProgressStream } from '@strav/signal/sse'

// Create SSE stream from generator
router.get('/updates', async (ctx) => {
  return ctx.sse(createSSEStream(async function* () {
    const updates = await getUpdates()
    for (const update of updates) {
      yield { event: 'update', data: update }
    }
  }))
})

// Progress stream helper
router.get('/process', async (ctx) => {
  return ctx.sse(createProgressStream(async (update) => {
    update(0, 'Starting...')
    await processStep1()
    update(33, 'Processing step 1...')
    await processStep2()
    update(66, 'Processing step 2...')
    await processStep3()
    update(100, 'Complete!')
  }))
})
```

## Examples

### Live notifications

Server:
```typescript
// Setup channel for user notifications
sse.channel('notifications/:userId', async (ctx, { userId }) => {
  const user = ctx.get('user')
  return user?.id === userId
})

// Send notification
async function notifyUser(userId: string, notification: Notification) {
  sse.to(`notifications/${userId}`).send('notification', {
    id: notification.id,
    title: notification.title,
    body: notification.body,
    timestamp: new Date()
  })
}
```

Client:
```typescript
const notifications = client.subscribe(`notifications/${currentUser.id}`)

notifications.on('notification', (data) => {
  showToast(data.title, data.body)
  incrementUnreadCount()
})
```

### Progress tracking

Server:
```typescript
router.post('/upload', async (ctx) => {
  const taskId = crypto.randomUUID()

  // Start async processing
  processUpload(taskId, ctx.body)

  // Return task ID for progress tracking
  return ctx.json({ taskId })
})

router.get('/upload/:taskId/progress', async (ctx) => {
  const taskId = ctx.params.taskId

  return ctx.sse(async function* () {
    while (true) {
      const progress = await getUploadProgress(taskId)
      yield {
        event: 'progress',
        data: progress
      }

      if (progress.complete) break
      await sleep(500)
    }
  })
})
```

Client:
```typescript
async function trackUpload(taskId: string) {
  const eventSource = new EventSource(`/upload/${taskId}/progress`)

  eventSource.addEventListener('progress', (event) => {
    const data = JSON.parse(event.data)
    updateProgressBar(data.percent)

    if (data.complete) {
      eventSource.close()
      showSuccess('Upload complete!')
    }
  })
}
```

### Server metrics dashboard

Server:
```typescript
sse.channel('metrics', {
  authorize: async (ctx) => {
    const user = ctx.get('user')
    return user?.role === 'admin'
  },
  heartbeat: 5000
})

// Broadcast metrics every second
setInterval(async () => {
  const metrics = await collectMetrics()
  sse.to('metrics').data(metrics)
}, 1000)
```

Client:
```typescript
const metrics = client.subscribe('metrics')
const chart = new Chart(canvas)

metrics.on('message', (data) => {
  chart.addDataPoint({
    cpu: data.cpu,
    memory: data.memory,
    requests: data.requestsPerSecond,
    timestamp: data.timestamp
  })
})
```

## API Reference

### SSEManager

```typescript
class SSEManager {
  static boot(router: Router, options?: SSEBootOptions): void
  static channel(pattern: string, config?: SSEAuthorizeCallback | SSEChannelConfig): void
  static to(channel: string): PendingSSEBroadcast
  static get connectionCount(): number
  static subscriberCount(channel: string): number
  static get activeChannels(): string[]
}
```

### SSEClient

```typescript
class SSEClient {
  constructor(options?: SSEClientOptions)
  get state(): SSEStateType
  get connected(): boolean
  subscribe(channel: string): SSESubscription
  unsubscribe(channel: string): void
  on(event: string, listener: SSEEventListener): () => void
  off(event: string, listener: SSEEventListener): void
  connect(): void
  disconnect(): void
  reconnect(): void
  close(): void
}
```

### Types

```typescript
interface SSEEvent {
  event?: string          // Event type/name
  data: string | object   // Event data
  id?: string            // Event ID for resuming
  retry?: number         // Retry hint in milliseconds
}

interface SSEBootOptions {
  path?: string          // SSE endpoint path (default: /_sse)
  middleware?: Middleware[]  // Middleware to run on connections
  defaultHeartbeat?: number  // Default heartbeat interval (default: 30000)
  cors?: string | string[]   // CORS origins (default: *)
}

interface SSEChannelConfig {
  authorize?: SSEAuthorizeCallback  // Authorization callback
  heartbeat?: number                 // Custom heartbeat interval
  headers?: Record<string, string>  // Custom headers
}

interface SSEClientOptions {
  url?: string                  // SSE endpoint URL
  withCredentials?: boolean     // Include credentials
  headers?: Record<string, string>  // Custom headers
  reconnectDelay?: number       // Initial reconnect delay
  maxReconnectDelay?: number    // Max reconnect delay
  maxReconnectAttempts?: number // Max reconnect attempts
  reconnectMultiplier?: number  // Backoff multiplier
}
```

## Differences from WebSocket Broadcasting

| Feature | SSE | WebSocket (Broadcast) |
|---------|-----|----------------------|
| **Direction** | Server → Client only | Bidirectional |
| **Protocol** | HTTP/HTTPS | WebSocket (ws/wss) |
| **Data format** | Text only (UTF-8) | Text or binary |
| **Reconnection** | Automatic (built-in) | Manual (library handles it) |
| **HTTP/2** | Works perfectly | Not compatible |
| **Proxy/Firewall** | Better compatibility | May be blocked |
| **Complexity** | Simple | More complex |
| **Use cases** | Notifications, feeds, progress | Chat, gaming, collaboration |

## Best Practices

1. **Use appropriate heartbeat intervals** - Balance between connection detection and bandwidth usage
2. **Implement authorization carefully** - SSE connections are long-lived HTTP requests
3. **Handle reconnections gracefully** - Clients will automatically reconnect on disconnection
4. **Use event types** - Named events make client-side handling cleaner
5. **Consider compression** - SSE is text-based, so gzip can significantly reduce bandwidth
6. **Monitor connection count** - Long-lived connections consume server resources
7. **Use channels wisely** - Broadcast to specific channels rather than all connections
8. **Clean up resources** - Close event sources when components unmount

## Testing

```typescript
import { describe, test, expect } from 'bun:test'
import { parseSSE, formatSSE } from '@strav/signal/sse'

test('SSE formatting and parsing', async () => {
  const event = {
    event: 'test',
    data: { message: 'hello' },
    id: '123'
  }

  const formatted = formatSSE(event)
  expect(formatted).toContain('event: test')
  expect(formatted).toContain('data: {"message":"hello"}')
  expect(formatted).toContain('id: 123')

  // Parse it back
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(formatted))
      controller.close()
    }
  })

  const events = []
  for await (const parsed of parseSSE(stream)) {
    events.push(parsed)
  }

  expect(events).toHaveLength(1)
  expect(events[0].event).toBe('test')
  expect(events[0].data).toEqual({ message: 'hello' })
})
```