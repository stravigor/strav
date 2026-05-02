import { Queue } from '@strav/queue'
import MessagingManager from './messaging_manager.ts'
import type {
  MessagingMedia,
  MessagingMessage,
  MessagingProviderName,
  MessagingResult,
} from './types.ts'

interface QueuedMessageJob {
  provider: MessagingProviderName | string
  message: MessagingMessage
}

/**
 * Fluent IM message builder. Returned by `messaging.via(...)` (or `messaging.to(...)`
 * which uses the default provider).
 *
 * @example
 * await messaging.via('whatsapp')
 *   .to('+15551234567')
 *   .text('Order shipped — track at https://...')
 *   .media({ kind: 'image', url: 'https://cdn.example.com/label.png' })
 *   .send()
 */
export class PendingMessage {
  private _provider: MessagingProviderName | string
  private _to = ''
  private _text?: string
  private _media: MessagingMedia[] = []
  private _replyTo?: string

  constructor(provider: MessagingProviderName | string) {
    this._provider = provider
  }

  to(recipient: string): this {
    this._to = recipient
    return this
  }

  text(value: string): this {
    this._text = value
    return this
  }

  media(item: MessagingMedia): this {
    this._media.push(item)
    return this
  }

  replyTo(token: string): this {
    this._replyTo = token
    return this
  }

  build(): MessagingMessage {
    return {
      to: this._to,
      text: this._text,
      media: this._media.length > 0 ? this._media : undefined,
      replyTo: this._replyTo,
    }
  }

  async send(): Promise<MessagingResult> {
    return MessagingManager.driver(this._provider).send(this.build())
  }

  async queue(options?: { queue?: string; delay?: number; attempts?: number }): Promise<number> {
    const job: QueuedMessageJob = { provider: this._provider, message: this.build() }
    return Queue.push('strav:send-messaging', job, options)
  }
}

/**
 * Messaging helper — primary outbound API.
 *
 * @example
 * import { messaging } from '@strav/signal/messaging'
 *
 * await messaging.via('whatsapp').to('+15551234567').text('Hi').send()
 *
 * await messaging.send({
 *   provider: 'line',
 *   to: 'U1234...',
 *   text: 'Welcome',
 *   media: [{ kind: 'image', url: 'https://...' }],
 * })
 */
export const messaging = {
  /** Start a fluent message via the named provider. */
  via(provider: MessagingProviderName | string): PendingMessage {
    return new PendingMessage(provider)
  },

  /** Start a fluent message via the configured default provider. */
  to(recipient: string): PendingMessage {
    return new PendingMessage(MessagingManager.config.default).to(recipient)
  },

  /** Send a message in one call. */
  async send(options: {
    provider?: MessagingProviderName | string
    to: string
    text?: string
    media?: MessagingMedia[]
    replyTo?: string
  }): Promise<MessagingResult> {
    const provider = options.provider ?? MessagingManager.config.default
    return MessagingManager.driver(provider).send({
      to: options.to,
      text: options.text,
      media: options.media,
      replyTo: options.replyTo,
    })
  },

  /**
   * Register the built-in queue handler for async messaging delivery.
   * Call this in your app bootstrap after Queue is configured.
   */
  registerQueueHandler(): void {
    Queue.handle<QueuedMessageJob>('strav:send-messaging', async job => {
      await MessagingManager.driver(job.provider).send(job.message)
    })
  },
}
