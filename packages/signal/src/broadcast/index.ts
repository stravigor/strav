export { default, default as BroadcastManager } from './broadcast_manager.ts'
export type {
  AuthorizeCallback,
  MessageHandler,
  ChannelConfig,
  BootOptions,
  PendingBroadcast,
} from './broadcast_manager.ts'
export { Broadcast, Subscription } from './client.ts'
export type { BroadcastOptions } from './client.ts'

import BroadcastManager from './broadcast_manager.ts'
import type { AuthorizeCallback, ChannelConfig, BootOptions } from './broadcast_manager.ts'
import type { Router } from '@strav/http'

/**
 * Broadcast helper — convenience object that delegates to `BroadcastManager`.
 *
 * @example
 * import { broadcast } from '@strav/signal/broadcast'
 *
 * // Bootstrap
 * broadcast.boot(router, { middleware: [session()] })
 *
 * // Define channels
 * broadcast.channel('notifications')
 * broadcast.channel('chats/:id', async (ctx, { id }) => !!ctx.get('user'))
 *
 * // Broadcast from anywhere
 * broadcast.to('notifications').send('alert', { text: 'Hello' })
 * broadcast.to(`chats/${chatId}`).except(senderId).send('message', data)
 */
export const broadcast = {
  /** Register the broadcast WebSocket endpoint on the router. */
  boot(router: Router, options?: BootOptions): void {
    BroadcastManager.boot(router, options)
  },

  /** Register a channel with optional authorization and message handlers. */
  channel(pattern: string, config?: AuthorizeCallback | ChannelConfig): void {
    BroadcastManager.channel(pattern, config)
  },

  /** Begin a broadcast to a channel. */
  to(channel: string) {
    return BroadcastManager.to(channel)
  },

  /** Number of active WebSocket connections. */
  get clientCount() {
    return BroadcastManager.clientCount
  },

  /** Number of subscribers on a specific channel. */
  subscriberCount(channel: string) {
    return BroadcastManager.subscriberCount(channel)
  },
}
