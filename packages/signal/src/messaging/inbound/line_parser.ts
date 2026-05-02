import { ConfigurationError, ExternalServiceError } from '@strav/kernel'
import type { InboundWebhookInput } from '../../mail/inbound/types.ts'
import type { MessagingMedia, MessagingMediaKind } from '../types.ts'
import type { InboundMessageParser, ParsedInboundMessage } from './types.ts'
import { toBuffer, verifyLineSignature } from './signature.ts'

/**
 * Parse a LINE Messaging API inbound webhook payload.
 *
 * Authentication is X-Line-Signature (base64 HMAC-SHA256 over the raw body
 * using the channel secret). The webhook delivers an array of typed events
 * under `events[]`; only `type === 'message'` entries are returned.
 *
 * `replyToken` is single-use and short-lived (~30s) — surface it on the
 * parsed message so consumers can use the cheaper /reply endpoint.
 *
 * Conversation source can be `user`, `group`, or `room`. We pick the
 * appropriate ID for `conversationId` and always set `fromUserId` to the
 * sender (when known).
 *
 * @see https://developers.line.biz/en/reference/messaging-api/#webhook-event-objects
 */
export class LineInboundParser implements InboundMessageParser {
  private readonly channelSecret: string

  constructor(config: { channelSecret: string }) {
    if (!config.channelSecret) {
      throw new ConfigurationError('LineInboundParser requires channelSecret')
    }
    this.channelSecret = config.channelSecret
  }

  async parse(input: InboundWebhookInput): Promise<ParsedInboundMessage[]> {
    const raw = toBuffer(input.body)
    verifyLineSignature(raw, input.headers['x-line-signature'], this.channelSecret)

    const payload = decodeJson(raw)
    const out: ParsedInboundMessage[] = []

    for (const event of arrayProp(payload, 'events')) {
      if (stringProp(event, 'type') !== 'message') continue
      const parsed = this.toParsed(event, payload)
      if (parsed) out.push(parsed)
    }

    return out
  }

  private toParsed(
    event: Record<string, unknown>,
    raw: unknown
  ): ParsedInboundMessage | null {
    const message = objectProp(event, 'message')
    const source = objectProp(event, 'source')
    if (!message || !source) return null

    const messageId = stringProp(message, 'id')
    if (!messageId) return null

    const sourceType = stringProp(source, 'type')
    const userId = stringProp(source, 'userId')
    const conversationId =
      sourceType === 'group'
        ? stringProp(source, 'groupId')
        : sourceType === 'room'
        ? stringProp(source, 'roomId')
        : userId
    if (!conversationId) return null

    const messageType = stringProp(message, 'type')
    const text = messageType === 'text' ? stringProp(message, 'text') : undefined
    const media = mapMedia(messageType, message)

    const timestamp = numberProp(event, 'timestamp')
    const replyToken = stringProp(event, 'replyToken')

    return {
      provider: 'line',
      conversationId,
      fromUserId: userId ?? conversationId,
      text,
      media,
      providerMessageId: messageId,
      replyToken,
      receivedAt: timestamp ? new Date(timestamp) : new Date(),
      raw,
    }
  }
}

const LINE_MESSAGE_KINDS: Record<string, MessagingMediaKind> = {
  image: 'image',
  audio: 'audio',
  video: 'video',
  file: 'file',
}

function mapMedia(type: string | undefined, message: Record<string, unknown>): MessagingMedia[] {
  if (!type) return []
  const kind = LINE_MESSAGE_KINDS[type]
  if (!kind) return []
  // LINE inbound media references are stable IDs you fetch via the content
  // API — no public URL is provided in the webhook.
  const item: MessagingMedia = { kind }
  const id = stringProp(message, 'id')
  if (id) item.mediaId = id
  const filename = stringProp(message, 'fileName')
  if (filename) item.filename = filename
  return [item]
}

function decodeJson(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf-8'))
  } catch (err) {
    throw new ExternalServiceError('LINE', 400, `Invalid JSON payload: ${(err as Error).message}`)
  }
}

function arrayProp(value: unknown, key: string): Record<string, unknown>[] {
  if (!value || typeof value !== 'object') return []
  const v = (value as Record<string, unknown>)[key]
  if (!Array.isArray(v)) return []
  return v.filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
}

function objectProp(value: unknown, key: string): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = (value as Record<string, unknown>)[key]
  return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined
}

function stringProp(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = (value as Record<string, unknown>)[key]
  return typeof v === 'string' ? v : undefined
}

function numberProp(value: unknown, key: string): number | undefined {
  if (!value || typeof value !== 'object') return undefined
  const v = (value as Record<string, unknown>)[key]
  return typeof v === 'number' ? v : undefined
}
