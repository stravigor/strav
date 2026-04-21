/**
 * Server-Sent Events (SSE) module for @strav/signal
 *
 * Provides complete SSE support for both server and client:
 * - Server-side channel management and broadcasting
 * - Client-side EventSource wrapper with auto-reconnect
 * - SSE parsing and formatting utilities
 * - Full TypeScript support
 *
 * @module @strav/signal/sse
 */

// Export types
export type {
  SSEEvent,
  RawSSEMessage,
  SSEAuthorizeCallback,
  SSEBootOptions,
  SSEChannelConfig,
  SSEChannelDefinition,
  SSEClientOptions,
  SSEConnection,
  SSEEventListener,
  SSEField,
  SSEStateType,
  SSEStreamOptions,
  SSESubscription,
} from './sse_types.ts'

// Export SSEState const
export { SSEState } from './sse_types.ts'

// Export manager
export { default as SSEManager } from './sse_manager.ts'
export type { PendingSSEBroadcast } from './sse_manager.ts'

// Export parser utilities
export {
  parseSSE,
  formatSSE,
  formatSSEComment,
  createSSEFormatter,
  createSSEParser,
  acceptsSSE,
  createSSEHeaders,
} from './sse_parser.ts'

// Export client (for browser use)
export { SSEClient } from './sse_client.ts'

// ---------------------------------------------------------------------------
// Convenience API
// ---------------------------------------------------------------------------

import SSEManager from './sse_manager.ts'
import type { Router } from '@strav/http'
import type { SSEAuthorizeCallback, SSEBootOptions, SSEChannelConfig } from './sse_types.ts'

/**
 * SSE helper — convenience object that delegates to SSEManager.
 *
 * Server-side usage:
 * @example
 * import { sse } from '@strav/signal/sse'
 *
 * // Bootstrap SSE endpoint
 * sse.boot(router, {
 *   middleware: [session()],
 *   cors: ['https://app.example.com']
 * })
 *
 * // Define channels with authorization
 * sse.channel('public/notifications')
 * sse.channel('users/:id', async (ctx, { id }) => {
 *   const user = ctx.get('user')
 *   return user?.id === id
 * })
 *
 * // Broadcast events
 * sse.to('public/notifications').send('alert', { level: 'info', message: 'Hello' })
 * sse.to(`users/${userId}`).except(senderId).send('message', { text: 'New message' })
 * sse.to('public/notifications').data({ timestamp: Date.now() })
 *
 * Client-side usage:
 * @example
 * import { SSEClient } from '@strav/signal/sse/client'
 *
 * const client = new SSEClient({ url: '/_sse' })
 *
 * const notifications = client.subscribe('public/notifications')
 * notifications.on('alert', (data) => {
 *   console.log('Alert:', data.level, data.message)
 * })
 *
 * const userChannel = client.subscribe(`users/${userId}`)
 * userChannel.on('message', (data) => {
 *   console.log('New message:', data.text)
 * })
 *
 * // Handle connection events
 * client.on('connected', () => console.log('SSE connected'))
 * client.on('error', (err) => console.error('SSE error:', err))
 */
export const sse = {
  /**
   * Register the SSE endpoint on the router.
   *
   * @param router - The HTTP router to register the endpoint on
   * @param options - Optional configuration for the SSE endpoint
   *
   * @example
   * sse.boot(router, {
   *   path: '/_sse',
   *   middleware: [authenticate()],
   *   defaultHeartbeat: 30000,
   *   cors: '*'
   * })
   */
  boot(router: Router, options?: SSEBootOptions): void {
    SSEManager.boot(router, options)
  },

  /**
   * Register a channel with optional authorization and configuration.
   *
   * @param pattern - Channel pattern (e.g., "notifications", "users/:id")
   * @param config - Authorization callback or full channel configuration
   *
   * @example
   * // Public channel
   * sse.channel('notifications')
   *
   * // Authorized channel with params
   * sse.channel('users/:id', async (ctx, { id }) => {
   *   return ctx.get('user')?.id === id
   * })
   *
   * // Channel with custom heartbeat
   * sse.channel('live-data', {
   *   authorize: async (ctx) => !!ctx.get('user'),
   *   heartbeat: 5000
   * })
   */
  channel(pattern: string, config?: SSEAuthorizeCallback | SSEChannelConfig): void {
    SSEManager.channel(pattern, config)
  },

  /**
   * Begin a broadcast to a channel.
   *
   * @param channel - The channel name to broadcast to
   * @returns A pending broadcast that can be configured before sending
   *
   * @example
   * // Simple broadcast
   * sse.to('notifications').send('alert', { message: 'Hello' })
   *
   * // Exclude specific clients
   * sse.to('chat').except(senderId).send('message', { text: 'Hi' })
   *
   * // Send data without event type
   * sse.to('metrics').data({ cpu: 0.75, memory: 0.82 })
   */
  to(channel: string) {
    return SSEManager.to(channel)
  },

  /**
   * Get the number of active SSE connections.
   */
  get connectionCount(): number {
    return SSEManager.connectionCount
  },

  /**
   * Get the number of subscribers for a specific channel.
   *
   * @param channel - The channel name
   * @returns Number of active subscribers
   */
  subscriberCount(channel: string): number {
    return SSEManager.subscriberCount(channel)
  },

  /**
   * Get list of all active channels.
   *
   * @returns Array of channel names with active subscribers
   */
  get activeChannels(): string[] {
    return SSEManager.activeChannels
  },
}

// ---------------------------------------------------------------------------
// Helper functions for common SSE patterns
// ---------------------------------------------------------------------------

/**
 * Create an SSE stream from an async generator.
 *
 * @example
 * return ctx.sse(createSSEStream(async function* () {
 *   for (let i = 0; i < 10; i++) {
 *     yield { event: 'progress', data: { percent: i * 10 } }
 *     await new Promise(resolve => setTimeout(resolve, 1000))
 *   }
 * }))
 */
export function createSSEStream(
  generator: AsyncGenerator<any, void, unknown>
): ReadableStream {
  return new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()
      try {
        const { formatSSE } = await import('./sse_parser.ts')
        for await (const event of generator) {
          const formatted = formatSSE(event)
          controller.enqueue(encoder.encode(formatted))
        }
      } catch (error) {
        controller.error(error)
      } finally {
        controller.close()
      }
    }
  })
}

/**
 * Create a simple SSE progress stream.
 *
 * @example
 * return ctx.sse(createProgressStream(async (update) => {
 *   for (let i = 0; i <= 100; i += 10) {
 *     update(i, `Processing... ${i}%`)
 *     await someAsyncWork()
 *   }
 * }))
 */
export function createProgressStream(
  task: (update: (percent: number, message?: string) => void) => Promise<void>
): ReadableStream {
  return new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()
      const { formatSSE } = await import('./sse_parser.ts')

      const update = (percent: number, message?: string) => {
        const event = formatSSE({
          event: 'progress',
          data: { percent, message }
        })
        controller.enqueue(encoder.encode(event))
      }

      try {
        await task(update)
        controller.enqueue(encoder.encode(
          formatSSE({ event: 'complete', data: { percent: 100 } })
        ))
      } catch (error) {
        controller.enqueue(encoder.encode(
          formatSSE({
            event: 'error',
            data: { message: error instanceof Error ? error.message : 'Unknown error' }
          })
        ))
      } finally {
        controller.close()
      }
    }
  })
}