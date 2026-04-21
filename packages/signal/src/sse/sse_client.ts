/**
 * Browser-side SSE client.
 *
 * Enhanced EventSource wrapper with:
 * - Auto-reconnection with exponential backoff
 * - Channel-based subscriptions
 * - Connection state management
 * - Error handling and recovery
 * - TypeScript support
 *
 * Zero dependencies — works in any modern browser.
 *
 * @example
 * import { SSEClient } from '@strav/signal/sse/client'
 *
 * const client = new SSEClient()
 *
 * const notifications = client.subscribe('notifications/123')
 * notifications.on('alert', (data) => console.log(data))
 * notifications.on('error', (err) => console.error(err))
 *
 * client.on('connected', () => console.log('SSE connected'))
 * client.on('disconnected', () => console.log('SSE disconnected'))
 */

import type {
  SSEClientOptions,
  SSEEventListener,
  SSESubscription,
  SSEStateType,
} from './sse_types.ts'
import { SSEState } from './sse_types.ts'

// ---------------------------------------------------------------------------
// SSE Subscription
// ---------------------------------------------------------------------------

/**
 * A subscription to a specific SSE channel.
 *
 * Listen for server events, handle errors, and manage the subscription lifecycle.
 *
 * @example
 * const sub = client.subscribe('users/123')
 * sub.on('status', (data) => console.log('User status:', data))
 * sub.on('error', (err) => console.error('Channel error:', err))
 * sub.close()
 */
class SSEChannelSubscription implements SSESubscription {
  private listeners = new Map<string, Set<SSEEventListener>>()
  private closed = false

  constructor(
    readonly channel: string,
    private unsubscribeFn: () => void
  ) {}

  /**
   * Listen for a specific event on this channel.
   * Returns a function that removes the listener when called.
   *
   * @example
   * const stop = sub.on('message', (data) => console.log(data))
   * stop() // remove listener
   */
  on<T = any>(event: string, listener: SSEEventListener<T>): () => void {
    if (this.closed) {
      throw new Error('Cannot add listener to closed subscription')
    }

    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(listener)

    return () => {
      set!.delete(listener)
      if (set!.size === 0) {
        this.listeners.delete(event)
      }
    }
  }

  /**
   * Remove a specific event listener.
   */
  off(event: string, listener: SSEEventListener): void {
    const set = this.listeners.get(event)
    if (set) {
      set.delete(listener)
      if (set.size === 0) {
        this.listeners.delete(event)
      }
    }
  }

  /**
   * Close this subscription and remove all listeners.
   */
  close(): void {
    if (!this.closed) {
      this.closed = true
      this.listeners.clear()
      this.unsubscribeFn()
    }
  }

  /** @internal Dispatch an incoming event to registered listeners */
  _dispatch(event: string, data: unknown): void {
    const listeners = this.listeners.get(event)
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(data)
        } catch (error) {
          console.error('SSE listener error:', error)
        }
      }
    }
  }

  /** @internal Check if subscription has any listeners */
  _hasListeners(): boolean {
    return this.listeners.size > 0
  }
}

// ---------------------------------------------------------------------------
// SSE Client
// ---------------------------------------------------------------------------

/**
 * SSE client with auto-reconnection and channel subscriptions.
 *
 * Manages connection lifecycle, handles reconnection with exponential backoff,
 * and routes events to channel subscriptions.
 *
 * @example
 * const client = new SSEClient({
 *   url: '/_sse',
 *   reconnectDelay: 1000,
 *   maxReconnectAttempts: 10
 * })
 *
 * client.on('connected', () => console.log('Connected'))
 * client.on('error', (err) => console.error('Connection error:', err))
 *
 * const sub = client.subscribe('notifications')
 * sub.on('alert', (data) => console.log('Alert:', data))
 */
export class SSEClient {
  private url: string
  private eventSource: EventSource | null = null
  private subscriptions = new Map<string, SSEChannelSubscription>()
  private listeners = new Map<string, Set<SSEEventListener>>()
  private clientId: string | null = null

  // Reconnection state
  private reconnectDelay: number
  private currentReconnectDelay: number
  private maxReconnectDelay: number
  private maxReconnectAttempts: number
  private reconnectMultiplier: number
  private reconnectAttempts = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null

  // Connection state
  private _state: SSEStateType = SSEState.CLOSED

  constructor(options?: SSEClientOptions) {
    // Auto-detect URL if not provided
    if (options?.url) {
      this.url = options.url
    } else if (typeof globalThis !== 'undefined' && 'location' in globalThis) {
      const location = (globalThis as any).location
      const protocol = location.protocol === 'https:' ? 'https:' : 'http:'
      const host = location.host
      this.url = `${protocol}//${host}/_sse`
    } else {
      this.url = 'http://localhost/_sse'
    }

    // Reconnection settings
    this.reconnectDelay = options?.reconnectDelay ?? 1000
    this.currentReconnectDelay = this.reconnectDelay
    this.maxReconnectDelay = options?.maxReconnectDelay ?? 30000
    this.maxReconnectAttempts = options?.maxReconnectAttempts ?? Infinity
    this.reconnectMultiplier = options?.reconnectMultiplier ?? 1.5

    // Auto-connect
    this.connect()
  }

  /**
   * Get current connection state.
   */
  get state(): SSEStateType {
    return this._state
  }

  /**
   * Check if client is connected.
   */
  get connected(): boolean {
    return this._state === SSEState.OPEN
  }

  /**
   * Subscribe to a channel.
   *
   * @example
   * const sub = client.subscribe('users/123')
   * sub.on('update', (data) => console.log(data))
   */
  subscribe(channel: string): SSESubscription {
    // Check if already subscribed
    let subscription = this.subscriptions.get(channel)
    if (subscription) {
      return subscription
    }

    // Create new subscription
    subscription = new SSEChannelSubscription(channel, () => {
      this.unsubscribe(channel)
    })
    this.subscriptions.set(channel, subscription)

    // Add channel to URL if connected
    if (this.connected) {
      this.reconnect()
    }

    return subscription
  }

  /**
   * Unsubscribe from a channel.
   */
  unsubscribe(channel: string): void {
    const subscription = this.subscriptions.get(channel)
    if (subscription) {
      subscription.close()
      this.subscriptions.delete(channel)

      // Reconnect to update channel list
      if (this.connected && this.subscriptions.size > 0) {
        this.reconnect()
      } else if (this.subscriptions.size === 0) {
        this.disconnect()
      }
    }
  }

  /**
   * Listen for client-level events.
   *
   * Available events:
   * - 'connected': Connection established
   * - 'disconnected': Connection lost
   * - 'error': Connection error
   * - 'reconnecting': Reconnection attempt starting
   */
  on(event: string, listener: SSEEventListener): () => void {
    let set = this.listeners.get(event)
    if (!set) {
      set = new Set()
      this.listeners.set(event, set)
    }
    set.add(listener)

    return () => {
      set!.delete(listener)
      if (set!.size === 0) {
        this.listeners.delete(event)
      }
    }
  }

  /**
   * Remove a client-level event listener.
   */
  off(event: string, listener: SSEEventListener): void {
    const set = this.listeners.get(event)
    if (set) {
      set.delete(listener)
      if (set.size === 0) {
        this.listeners.delete(event)
      }
    }
  }

  /**
   * Manually connect to SSE endpoint.
   */
  connect(): void {
    if (this._state === SSEState.CONNECTING) return

    this._state = SSEState.CONNECTING
    this.clearReconnectTimer()

    // Build URL with channel parameters
    const channels = Array.from(this.subscriptions.keys())
    if (channels.length === 0) {
      // No channels to subscribe to
      this._state = SSEState.CLOSED
      return
    }

    const url = new URL(this.url)
    for (const channel of channels) {
      url.searchParams.append('channel', channel)
    }

    // Create EventSource
    try {
      // EventSource is a browser API
      const EventSourceConstructor = (globalThis as any).EventSource
      if (!EventSourceConstructor) {
        throw new Error('EventSource not available')
      }
      this.eventSource = new EventSourceConstructor(url.toString())

      this.eventSource!.onopen = () => {
        this._state = SSEState.OPEN
        this.reconnectAttempts = 0
        this.currentReconnectDelay = this.reconnectDelay
        this.emit('connected')
      }

      this.eventSource!.onerror = (event) => {
        this.emit('error', event)
        if (this.eventSource?.readyState === 2) {
          this.handleDisconnection()
        }
      }

      this.eventSource!.onmessage = (event: any) => {
        this.handleMessage(event)
      }

      // Add event listeners for typed events
      this.eventSource!.addEventListener('welcome', (event: any) => {
        const data = JSON.parse(event.data)
        this.clientId = data.clientId
      })

      this.eventSource!.addEventListener('subscribed', (event: any) => {
        const data = JSON.parse(event.data)
        this.emit('subscribed', data.channel)
      })

      this.eventSource!.addEventListener('unauthorized', (event: any) => {
        const data = JSON.parse(event.data)
        const subscription = this.subscriptions.get(data.channel)
        if (subscription) {
          subscription._dispatch('error', new Error(`Unauthorized for channel: ${data.channel}`))
        }
      })

      // Route channel events to subscriptions
      for (const [channel, subscription] of this.subscriptions) {
        this.eventSource!.addEventListener(channel, (event: any) => {
          try {
            const parsed = JSON.parse(event.data)
            subscription._dispatch(parsed.event || 'message', parsed.data)
          } catch {
            subscription._dispatch('message', event.data)
          }
        })
      }
    } catch (error) {
      this.emit('error', error)
      this.handleDisconnection()
    }
  }

  /**
   * Manually disconnect from SSE endpoint.
   */
  disconnect(): void {
    this.clearReconnectTimer()

    if (this.eventSource) {
      this.eventSource.close()
      this.eventSource = null
    }

    if (this._state !== SSEState.CLOSED) {
      this._state = SSEState.CLOSED
      this.clientId = null
      this.emit('disconnected')
    }
  }

  /**
   * Reconnect with current subscriptions.
   */
  reconnect(): void {
    this.disconnect()
    this.connect()
  }

  /**
   * Close all subscriptions and disconnect.
   */
  close(): void {
    // Close all subscriptions
    for (const subscription of this.subscriptions.values()) {
      subscription.close()
    }
    this.subscriptions.clear()

    // Clear listeners
    this.listeners.clear()

    // Disconnect
    this.disconnect()
  }

  // ---------------------------------------------------------------------------
  // Private methods
  // ---------------------------------------------------------------------------

  private handleMessage(event: any): void {
    try {
      const data = JSON.parse(event.data)

      // Check if it's a channel message
      if (data.channel && data.event) {
        const subscription = this.subscriptions.get(data.channel)
        if (subscription) {
          subscription._dispatch(data.event, data.data)
        }
      }
    } catch {
      // Not JSON, treat as plain message
      this.emit('message', event.data)
    }
  }

  private handleDisconnection(): void {
    this._state = SSEState.CLOSED
    this.eventSource = null
    this.emit('disconnected')

    // Attempt reconnection if we have subscriptions
    if (this.subscriptions.size > 0 && this.reconnectAttempts < this.maxReconnectAttempts) {
      this.scheduleReconnect()
    }
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer()

    this.reconnectAttempts++
    this.emit('reconnecting', {
      attempt: this.reconnectAttempts,
      delay: this.currentReconnectDelay
    })

    this.reconnectTimer = setTimeout(() => {
      this.connect()
    }, this.currentReconnectDelay)

    // Exponential backoff
    this.currentReconnectDelay = Math.min(
      this.currentReconnectDelay * this.reconnectMultiplier,
      this.maxReconnectDelay
    )
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private emit(event: string, data?: unknown): void {
    const listeners = this.listeners.get(event)
    if (listeners) {
      for (const listener of listeners) {
        try {
          listener(data)
        } catch (error) {
          console.error('SSE client listener error:', error)
        }
      }
    }
  }
}

// Export SSEState for external use
export { SSEState } from './sse_types.ts'