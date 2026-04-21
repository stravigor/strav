import { Context, compose, type Middleware, type Router } from '@strav/http'
import { formatSSE, formatSSEComment, createSSEHeaders } from './sse_parser.ts'
import type {
  SSEAuthorizeCallback,
  SSEBootOptions,
  SSEChannelConfig,
  SSEChannelDefinition,
  SSEConnection,
  SSEEvent,
} from './sse_types.ts'

// ---------------------------------------------------------------------------
// Pending SSE Broadcast
// ---------------------------------------------------------------------------

export interface PendingSSEBroadcast {
  /** Exclude specific client IDs from receiving the broadcast */
  except(...clientIds: string[]): PendingSSEBroadcast
  /** Send an event to the channel */
  send(event: string, data?: unknown): void
  /** Send data without an event type */
  data(data: unknown): void
}

// ---------------------------------------------------------------------------
// SSE Manager
// ---------------------------------------------------------------------------

/**
 * Server-Sent Events manager for channel-based broadcasting.
 *
 * Manages SSE endpoints, client connections, channel subscriptions,
 * and event broadcasting with authorization support.
 *
 * @example
 * // Bootstrap
 * SSEManager.boot(router, { middleware: [session()] })
 *
 * // Define channels
 * SSEManager.channel('notifications')
 * SSEManager.channel('users/:id', async (ctx, { id }) => {
 *   return ctx.get('user')?.id === id
 * })
 *
 * // Broadcast events
 * SSEManager.to('notifications').send('alert', { message: 'Hello' })
 * SSEManager.to(`users/${userId}`).data({ status: 'online' })
 */
export default class SSEManager {
  private static _channels: SSEChannelDefinition[] = []
  private static _connections = new Map<string, SSEConnection>()
  private static _subscribers = new Map<string, Set<string>>()
  private static _middleware: Middleware[] = []
  private static _defaultHeartbeat = 30000
  private static _corsOrigins: string | string[] = '*'

  /**
   * Register SSE endpoint on the router.
   */
  static boot(router: Router, options?: SSEBootOptions): void {
    const path = options?.path ?? '/_sse'
    SSEManager._defaultHeartbeat = options?.defaultHeartbeat ?? 30000
    SSEManager._corsOrigins = options?.cors ?? '*'

    if (options?.middleware) {
      SSEManager._middleware = options.middleware
    }

    // Register SSE endpoint
    router.get(path, async (ctx) => {
      // Check if client accepts SSE
      const accept = ctx.headers.get('accept') ?? ''
      if (!accept.includes('text/event-stream')) {
        return ctx.json({ error: 'SSE not accepted' }, 406)
      }

      // Run middleware
      if (SSEManager._middleware.length > 0) {
        const handler = compose(SSEManager._middleware, async () => new Response(''))
        const response = await handler(ctx)
        // If middleware returns a non-empty response, use it
        if (response && response.status !== 200) return response
      }

      // Get requested channels from query params
      const channels = ctx.query.getAll('channel')
      if (channels.length === 0) {
        return ctx.json({ error: 'No channels specified' }, 400)
      }

      // Create SSE response
      const headers = createSSEHeaders({
        cors: SSEManager._corsOrigins,
      })

      const stream = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder()
          const clientId = crypto.randomUUID()

          // Create connection
          const connection: SSEConnection = {
            id: clientId,
            channels: new Set(),
            writer: controller as any, // We'll write directly to controller
            context: ctx,
            lastActivity: Date.now(),
          }

          SSEManager._connections.set(clientId, connection)

          // Send welcome message
          controller.enqueue(encoder.encode(
            formatSSE({ event: 'welcome', data: { clientId } })
          ))

          // Subscribe to requested channels
          for (const channel of channels) {
            const authorized = await SSEManager.authorizeChannel(channel, ctx)
            if (authorized) {
              SSEManager.subscribeToChannel(clientId, channel)
              controller.enqueue(encoder.encode(
                formatSSE({ event: 'subscribed', data: { channel } })
              ))
            } else {
              controller.enqueue(encoder.encode(
                formatSSE({ event: 'unauthorized', data: { channel } })
              ))
            }
          }

          // Setup heartbeat
          const heartbeat = SSEManager.getHeartbeatInterval(channels)
          if (heartbeat > 0) {
            connection.heartbeatTimer = setInterval(() => {
              try {
                controller.enqueue(encoder.encode(formatSSEComment('heartbeat')))
                connection.lastActivity = Date.now()
              } catch {
                // Connection closed
                SSEManager.cleanupConnection(clientId)
              }
            }, heartbeat)
          }
        },

        cancel() {
          // Client disconnected
          // Connection will be cleaned up when stream ends
        }
      })

      return new Response(stream, { headers })
    })

    // Add dynamic subscription endpoint
    router.post(`${path}/subscribe`, async (ctx) => {
      const clientId = ctx.query.get('client_id')
      const channel = ctx.query.get('channel')

      if (!clientId || !channel) {
        return ctx.json({ error: 'Missing parameters' }, 400)
      }

      const connection = SSEManager._connections.get(clientId)
      if (!connection) {
        return ctx.json({ error: 'Invalid client' }, 404)
      }

      // Run middleware for authorization
      if (SSEManager._middleware.length > 0) {
        const handler = compose(SSEManager._middleware, async () => new Response(''))
        const response = await handler(ctx)
        if (response && response.status !== 200) return response
      }

      const authorized = await SSEManager.authorizeChannel(channel, ctx)
      if (!authorized) {
        return ctx.json({ error: 'Unauthorized' }, 403)
      }

      SSEManager.subscribeToChannel(clientId, channel)
      SSEManager.sendToClient(clientId, {
        event: 'subscribed',
        data: { channel }
      })

      return ctx.json({ success: true })
    })

    // Add unsubscribe endpoint
    router.post(`${path}/unsubscribe`, async (ctx) => {
      const clientId = ctx.query.get('client_id')
      const channel = ctx.query.get('channel')

      if (!clientId || !channel) {
        return ctx.json({ error: 'Missing parameters' }, 400)
      }

      SSEManager.unsubscribeFromChannel(clientId, channel)
      SSEManager.sendToClient(clientId, {
        event: 'unsubscribed',
        data: { channel }
      })

      return ctx.json({ success: true })
    })
  }

  /**
   * Register a channel with optional authorization.
   */
  static channel(
    pattern: string,
    config?: SSEAuthorizeCallback | SSEChannelConfig
  ): void {
    const channelConfig: SSEChannelConfig = typeof config === 'function'
      ? { authorize: config }
      : config ?? {}

    const { regex, paramNames } = SSEManager.parsePattern(pattern)

    SSEManager._channels.push({
      pattern,
      regex,
      paramNames,
      config: channelConfig,
    })
  }

  /**
   * Begin a broadcast to a channel.
   */
  static to(channel: string): PendingSSEBroadcast {
    const excludedClients = new Set<string>()

    return {
      except(...clientIds: string[]) {
        for (const id of clientIds) {
          excludedClients.add(id)
        }
        return this
      },

      send(event: string, data?: unknown) {
        SSEManager.broadcastToChannel(channel, { event, data: data ?? '' as string | object }, excludedClients)
      },

      data(data: unknown) {
        SSEManager.broadcastToChannel(channel, { data: data as string | object }, excludedClients)
      },
    }
  }

  /**
   * Get number of active connections.
   */
  static get connectionCount(): number {
    return SSEManager._connections.size
  }

  /**
   * Get number of subscribers for a channel.
   */
  static subscriberCount(channel: string): number {
    return SSEManager._subscribers.get(channel)?.size ?? 0
  }

  /**
   * Get all active channels.
   */
  static get activeChannels(): string[] {
    return Array.from(SSEManager._subscribers.keys())
  }

  // ---------------------------------------------------------------------------
  // Private methods
  // ---------------------------------------------------------------------------

  private static parsePattern(pattern: string): {
    regex: RegExp
    paramNames: string[]
  } {
    const paramNames: string[] = []
    const regexStr = pattern
      .replace(/\/\*(\w+)/, (_, name) => {
        paramNames.push(name)
        return '/(.+)'
      })
      .replace(/:(\w+)/g, (_, name) => {
        paramNames.push(name)
        return '([^/]+)'
      })
    return { regex: new RegExp(`^${regexStr}$`), paramNames }
  }

  private static extractParams(
    names: string[],
    match: RegExpExecArray
  ): Record<string, string> {
    const params: Record<string, string> = {}
    for (let i = 0; i < names.length; i++) {
      params[names[i]!] = match[i + 1]!
    }
    return params
  }

  private static findChannelDefinition(
    channel: string
  ): { definition: SSEChannelDefinition; params: Record<string, string> } | null {
    for (const definition of SSEManager._channels) {
      const match = definition.regex.exec(channel)
      if (match) {
        const params = SSEManager.extractParams(definition.paramNames, match)
        return { definition, params }
      }
    }
    return null
  }

  private static async authorizeChannel(
    channel: string,
    ctx: Context
  ): Promise<boolean> {
    const result = SSEManager.findChannelDefinition(channel)
    if (!result) return true // Allow if no definition exists

    const { definition, params } = result
    if (!definition.config.authorize) return true

    try {
      return await definition.config.authorize(ctx, params)
    } catch {
      return false
    }
  }

  private static getHeartbeatInterval(channels: string[]): number {
    let minHeartbeat = SSEManager._defaultHeartbeat

    for (const channel of channels) {
      const result = SSEManager.findChannelDefinition(channel)
      if (result?.definition.config.heartbeat !== undefined) {
        const heartbeat = result.definition.config.heartbeat
        if (heartbeat > 0 && heartbeat < minHeartbeat) {
          minHeartbeat = heartbeat
        }
      }
    }

    return minHeartbeat
  }

  private static subscribeToChannel(clientId: string, channel: string): void {
    const connection = SSEManager._connections.get(clientId)
    if (!connection) return

    connection.channels.add(channel)

    let subscribers = SSEManager._subscribers.get(channel)
    if (!subscribers) {
      subscribers = new Set()
      SSEManager._subscribers.set(channel, subscribers)
    }
    subscribers.add(clientId)
  }

  private static unsubscribeFromChannel(clientId: string, channel: string): void {
    const connection = SSEManager._connections.get(clientId)
    if (connection) {
      connection.channels.delete(channel)
    }

    const subscribers = SSEManager._subscribers.get(channel)
    if (subscribers) {
      subscribers.delete(clientId)
      if (subscribers.size === 0) {
        SSEManager._subscribers.delete(channel)
      }
    }
  }

  private static sendToClient(clientId: string, event: SSEEvent): void {
    const connection = SSEManager._connections.get(clientId)
    if (!connection) return

    try {
      const encoder = new TextEncoder()
      const data = formatSSE(event)
      ;(connection.writer as any).enqueue(encoder.encode(data))
      connection.lastActivity = Date.now()
    } catch {
      // Connection closed
      SSEManager.cleanupConnection(clientId)
    }
  }

  private static broadcastToChannel(
    channel: string,
    event: SSEEvent,
    excludedClients: Set<string>
  ): void {
    const subscribers = SSEManager._subscribers.get(channel)
    if (!subscribers) return

    for (const clientId of subscribers) {
      if (!excludedClients.has(clientId)) {
        SSEManager.sendToClient(clientId, event)
      }
    }
  }

  private static cleanupConnection(clientId: string): void {
    const connection = SSEManager._connections.get(clientId)
    if (!connection) return

    // Clear heartbeat timer
    if (connection.heartbeatTimer) {
      clearInterval(connection.heartbeatTimer)
    }

    // Unsubscribe from all channels
    for (const channel of connection.channels) {
      SSEManager.unsubscribeFromChannel(clientId, channel)
    }

    // Remove connection
    SSEManager._connections.delete(clientId)
  }
}