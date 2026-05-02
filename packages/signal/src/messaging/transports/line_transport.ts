import { ConfigurationError, ExternalServiceError } from '@strav/kernel'
import type {
  LineConfig,
  MessagingMedia,
  MessagingMessage,
  MessagingResult,
  MessagingTransport,
} from '../types.ts'

/**
 * LINE Messaging API outbound transport.
 *
 * Uses the /v2/bot/message/reply endpoint when `replyTo` is set (the value
 * being a single-use reply token from the inbound event), otherwise
 * /v2/bot/message/push. LINE batches text + media into a single request:
 * `messages` is an array (max 5 per call). LINE does not return per-message
 * IDs in the response, so providerMessageId is left undefined.
 *
 * Image messages require both `originalContentUrl` and `previewImageUrl`.
 * Video messages require `originalContentUrl` and `previewImageUrl`. When a
 * preview is not provided we fall back to the original URL.
 *
 * @see https://developers.line.biz/en/reference/messaging-api/
 */
export class LineTransport implements MessagingTransport {
  readonly name = 'line'
  private readonly channelAccessToken: string
  private readonly baseUrl: string

  constructor(config: LineConfig) {
    if (!config.channelAccessToken) {
      throw new ConfigurationError('LineTransport requires channelAccessToken')
    }
    this.channelAccessToken = config.channelAccessToken
    this.baseUrl = config.baseUrl ?? 'https://api.line.me'
  }

  async send(message: MessagingMessage): Promise<MessagingResult> {
    const messages: Record<string, unknown>[] = []
    if (message.text) messages.push({ type: 'text', text: message.text })
    for (const media of message.media ?? []) messages.push(this.buildMedia(media))

    if (messages.length === 0) {
      throw new ExternalServiceError('LINE', 400, 'Message must include text or media')
    }
    if (messages.length > 5) {
      throw new ExternalServiceError('LINE', 400, 'LINE allows at most 5 messages per request')
    }

    const isReply = Boolean(message.replyTo)
    const url = isReply
      ? `${this.baseUrl}/v2/bot/message/reply`
      : `${this.baseUrl}/v2/bot/message/push`
    const body: Record<string, unknown> = isReply
      ? { replyToken: message.replyTo, messages }
      : { to: message.to, messages }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.channelAccessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    const raw = await readJson(response)
    if (!response.ok) {
      throw new ExternalServiceError('LINE', response.status, formatError(raw))
    }
    return { raw }
  }

  private buildMedia(media: MessagingMedia): Record<string, unknown> {
    if (!media.url) {
      throw new ExternalServiceError(
        'LINE',
        400,
        'LINE media requires `url` (no upload-by-id flow on the public API)'
      )
    }
    switch (media.kind) {
      case 'image':
        return {
          type: 'image',
          originalContentUrl: media.url,
          previewImageUrl: media.url,
        }
      case 'video':
        return {
          type: 'video',
          originalContentUrl: media.url,
          previewImageUrl: media.url,
        }
      case 'audio':
        return { type: 'audio', originalContentUrl: media.url, duration: 60_000 }
      case 'file':
        // LINE Messaging API has no first-class document type; fall back to text.
        return {
          type: 'text',
          text: `${media.caption ?? media.filename ?? 'file'}: ${media.url}`,
        }
    }
  }
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text()
  if (!text) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function formatError(raw: unknown): string {
  if (!raw) return 'Empty response'
  if (typeof raw === 'string') return raw
  if (typeof raw === 'object') {
    const message = (raw as Record<string, unknown>).message
    if (typeof message === 'string') return message
  }
  return JSON.stringify(raw)
}
