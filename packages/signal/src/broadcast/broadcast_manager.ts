import type { ServerWebSocket } from 'bun'
import { Context, compose, type Middleware, type Router, type WebSocketData } from '@strav/http'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Authorization callback — return true to allow subscription. */
export type AuthorizeCallback = (
  ctx: Context,
  params: Record<string, string>
) => boolean | Promise<boolean>

/** Handler for client messages on a channel. */
export type MessageHandler = (
  ctx: Context,
  params: Record<string, string>,
  data: unknown
) => void | Promise<void>

/** Full channel configuration with authorization and message handlers. */
export interface ChannelConfig {
  authorize?: AuthorizeCallback
  messages?: Record<string, MessageHandler>
}

export interface BootOptions {
  /** WebSocket endpoint path. Default: `/_broadcast` */
  path?: string
  /** Middleware to run on each WebSocket connection (e.g. session). */
  middleware?: Middleware[]
  /** Keepalive ping interval in ms. 0 to disable. Default: 30000 */
  pingInterval?: number
}

interface ChannelDefinition {
  pattern: string
  regex: RegExp
  paramNames: string[]
  authorize?: AuthorizeCallback
  messages?: Record<string, MessageHandler>
}

interface ClientConnection {
  ws: ServerWebSocket<WebSocketData>
  clientId: string
  channels: Set<string>
  ctxReady: Promise<Context>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parsePattern(pattern: string): { regex: RegExp; paramNames: string[] } {
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

function extractParams(names: string[], match: RegExpExecArray): Record<string, string> {
  const params: Record<string, string> = {}
  for (let i = 0; i < names.length; i++) {
    params[names[i]!] = match[i + 1]!
  }
  return params
}

// ---------------------------------------------------------------------------
// PendingBroadcast — fluent builder for .to().except().send()
// ---------------------------------------------------------------------------

export interface PendingBroadcast {
  /** Exclude a specific client from receiving the broadcast. */
  except(clientId: string): PendingBroadcast
  /** Send an event with optional data to the channel. */
  send(event: string, data?: unknown): void
}

// ---------------------------------------------------------------------------
// BroadcastManager
// ---------------------------------------------------------------------------

/**
 * Channel-based WebSocket broadcasting.
 *
 * Manages channel definitions, client connections, subscriptions,
 * and message routing over a single multiplexed WebSocket endpoint.
 *
 * @example
 * // Bootstrap
 * BroadcastManager.boot(router, { middleware: [session()] })
 *
 * // Define channels
 * BroadcastManager.channel('notifications')
 * BroadcastManager.channel('chats/:id', async (ctx, { id }) => !!ctx.get('user'))
 *
 * // Broadcast
 * BroadcastManager.to('notifications').send('alert', { text: 'Hello' })
 */
export default class BroadcastManager {
  private static _channels: ChannelDefinition[] = []
  private static _clients = new Map<string, ClientConnection>()
  private static _subscribers = new Map<string, Set<string>>()
  private static _wsToClient = new WeakMap<object, string>()
  private static _middleware: Middleware[] = []
  private static _pingTimer: ReturnType<typeof setInterval> | null = null

  /**
   * Register the broadcast WebSocket endpoint on the router.
   *
   * @example
   * BroadcastManager.boot(router, {
   *   middleware: [session()],
   *   pingInterval: 30_000,
   * })
   */
  static boot(router: Router, options?: BootOptions): void {
    const path = options?.path ?? '/_broadcast'
    const pingInterval = options?.pingInterval ?? 30_000

    if (options?.middleware) {
      BroadcastManager._middleware = options.middleware
    }

    router.ws(path, {
      open(ws) {
        const clientId = crypto.randomUUID()
        BroadcastManager._wsToClient.set(ws, clientId)

        const ctxReady = BroadcastManager.buildContext(ws)
        BroadcastManager._clients.set(clientId, {
          ws,
          clientId,
          channels: new Set(),
          ctxReady,
        })

        ws.send(JSON.stringify({ t: 'welcome', id: clientId }))
      },

      async message(ws, raw) {
        try {
          const msg = JSON.parse(raw as string)
          const clientId = BroadcastManager._wsToClient.get(ws)
          if (!clientId) return

          const client = BroadcastManager._clients.get(clientId)
          if (!client) return

          switch (msg.t) {
            case 'sub':
              await BroadcastManager.handleSubscribe(client, msg.c)
              break
            case 'unsub':
              BroadcastManager.handleUnsubscribe(client, msg.c)
              break
            case 'msg':
              await BroadcastManager.handleMessage(client, msg.c, msg.e, msg.d)
              break
            case 'pong':
              break
          }
        } catch {
          // Malformed message — silently ignore
        }
      },

      close(ws) {
        const clientId = BroadcastManager._wsToClient.get(ws)
        if (clientId) BroadcastManager.removeClient(clientId)
      },
    })

    // Keepalive pings
    if (pingInterval > 0) {
      BroadcastManager._pingTimer = setInterval(() => {
        const ping = JSON.stringify({ t: 'ping' })
        for (const client of BroadcastManager._clients.values()) {
          try {
            client.ws.send(ping)
          } catch {}
        }
      }, pingInterval)
    }
  }

  /**
   * Register a channel.
   *
   * Accepts either an authorization callback or a full config with
   * message handlers for bidirectional communication.
   *
   * @example
   * // Public channel
   * BroadcastManager.channel('announcements')
   *
   * // Authorized channel
   * BroadcastManager.channel('chats/:id', async (ctx, { id }) => {
   *   return !!ctx.get('user')
   * })
   *
   * // Channel with message handlers
   * BroadcastManager.channel('chat/:id', {
   *   authorize: async (ctx, { id }) => !!ctx.get('user'),
   *   messages: {
   *     async send(ctx, { id }, data) {
   *       BroadcastManager.to(`chat/${id}`).send('new_message', data)
   *     }
   *   }
   * })
   */
  static channel(pattern: string, config?: AuthorizeCallback | ChannelConfig): void {
    const { regex, paramNames } = parsePattern(pattern)

    let authorize: AuthorizeCallback | undefined
    let messages: Record<string, MessageHandler> | undefined

    if (typeof config === 'function') {
      authorize = config
    } else if (config) {
      authorize = config.authorize
      messages = config.messages
    }

    BroadcastManager._channels.push({ pattern, regex, paramNames, authorize, messages })
  }

  /**
   * Begin a broadcast to a channel.
   *
   * @example
   * BroadcastManager.to('chat/1').send('message', { text: 'Hello' })
   * BroadcastManager.to('chat/1').except(senderId).send('message', data)
   */
  static to(channel: string): PendingBroadcast & { except(clientId: string): PendingBroadcast } {
    let excluded: string | null = null

    const pending: PendingBroadcast & { except(clientId: string): PendingBroadcast } = {
      except(clientId: string) {
        excluded = clientId
        return pending
      },
      send(event: string, data?: unknown) {
        BroadcastManager.broadcastToChannel(channel, event, data, excluded)
      },
    }

    return pending
  }

  /** Number of active WebSocket connections. */
  static get clientCount(): number {
    return BroadcastManager._clients.size
  }

  /** Number of subscribers on a specific channel. */
  static subscriberCount(channel: string): number {
    return BroadcastManager._subscribers.get(channel)?.size ?? 0
  }

  /** Clear all state. Intended for test teardown. */
  static reset(): void {
    if (BroadcastManager._pingTimer) {
      clearInterval(BroadcastManager._pingTimer)
      BroadcastManager._pingTimer = null
    }
    BroadcastManager._channels = []
    BroadcastManager._clients.clear()
    BroadcastManager._subscribers.clear()
    BroadcastManager._middleware = []
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private static async buildContext(ws: ServerWebSocket<WebSocketData>): Promise<Context> {
    const request = ws.data?.request
    if (!request) return new Context(new Request('http://localhost'), {})

    const ctx = new Context(request, {})

    if (BroadcastManager._middleware.length > 0) {
      const noop = () => new Response(null)
      await compose(BroadcastManager._middleware, noop)(ctx)
    }

    return ctx
  }

  private static async handleSubscribe(
    client: ClientConnection,
    channelName: string
  ): Promise<void> {
    if (!channelName) return

    // Already subscribed
    if (client.channels.has(channelName)) {
      client.ws.send(JSON.stringify({ t: 'ok', c: channelName }))
      return
    }

    const match = BroadcastManager.matchChannel(channelName)
    if (!match) {
      client.ws.send(JSON.stringify({ t: 'err', c: channelName, r: 'unknown channel' }))
      return
    }

    const { definition, params } = match

    if (definition.authorize) {
      try {
        const ctx = await client.ctxReady
        const allowed = await definition.authorize(ctx, params)
        if (!allowed) {
          client.ws.send(JSON.stringify({ t: 'err', c: channelName, r: 'unauthorized' }))
          return
        }
      } catch {
        client.ws.send(JSON.stringify({ t: 'err', c: channelName, r: 'authorization failed' }))
        return
      }
    }

    // Add to subscribers
    client.channels.add(channelName)
    let subs = BroadcastManager._subscribers.get(channelName)
    if (!subs) {
      subs = new Set()
      BroadcastManager._subscribers.set(channelName, subs)
    }
    subs.add(client.clientId)

    client.ws.send(JSON.stringify({ t: 'ok', c: channelName }))
  }

  private static handleUnsubscribe(client: ClientConnection, channelName: string): void {
    if (!channelName) return
    client.channels.delete(channelName)
    const subs = BroadcastManager._subscribers.get(channelName)
    if (subs) {
      subs.delete(client.clientId)
      if (subs.size === 0) BroadcastManager._subscribers.delete(channelName)
    }
  }

  private static async handleMessage(
    client: ClientConnection,
    channelName: string,
    event: string,
    data: unknown
  ): Promise<void> {
    if (!channelName || !event) return
    if (!client.channels.has(channelName)) return

    const match = BroadcastManager.matchChannel(channelName)
    if (!match?.definition.messages?.[event]) return

    const ctx = await client.ctxReady
    ;(ctx as any).clientId = client.clientId

    await match.definition.messages[event]!(ctx, match.params, data)
  }

  private static matchChannel(
    channelName: string
  ): { definition: ChannelDefinition; params: Record<string, string> } | null {
    for (const def of BroadcastManager._channels) {
      const m = def.regex.exec(channelName)
      if (m) return { definition: def, params: extractParams(def.paramNames, m) }
    }
    return null
  }

  private static broadcastToChannel(
    channel: string,
    event: string,
    data: unknown,
    excludeClientId: string | null
  ): void {
    const subs = BroadcastManager._subscribers.get(channel)
    if (!subs || subs.size === 0) return

    const msg = JSON.stringify({ t: 'msg', c: channel, e: event, d: data })

    for (const clientId of subs) {
      if (clientId === excludeClientId) continue
      const client = BroadcastManager._clients.get(clientId)
      if (client) {
        try {
          client.ws.send(msg)
        } catch {}
      }
    }
  }

  private static removeClient(clientId: string): void {
    const client = BroadcastManager._clients.get(clientId)
    if (!client) return

    for (const channel of client.channels) {
      const subs = BroadcastManager._subscribers.get(channel)
      if (subs) {
        subs.delete(clientId)
        if (subs.size === 0) BroadcastManager._subscribers.delete(channel)
      }
    }

    BroadcastManager._clients.delete(clientId)
  }
}
