import { ConfigurationError, ExternalServiceError } from '@strav/kernel'
import type { InboundWebhookInput } from '../../mail/inbound/types.ts'
import type { MessagingMedia, MessagingMediaKind } from '../types.ts'
import type { InboundMessageParser, ParsedInboundMessage } from './types.ts'
import { toBuffer, verifyXHubSignature256 } from './signature.ts'

/**
 * Parse a Facebook Messenger inbound webhook payload.
 *
 * Authentication is X-Hub-Signature-256 (HMAC-SHA256 over the raw body using
 * the app secret). Page subscriptions deliver
 * `entry[].messaging[]` events. Only entries with a `message` are returned;
 * delivery and read receipts, postbacks, and echoes are filtered out.
 *
 * Echoes (`message.is_echo === true`) are messages your own page sent — keep
 * them out of inbound to avoid loops.
 *
 * @see https://developers.facebook.com/docs/messenger-platform/webhooks
 */
export class MessengerInboundParser implements InboundMessageParser {
  private readonly appSecret: string

  constructor(config: { appSecret: string }) {
    if (!config.appSecret) {
      throw new ConfigurationError('MessengerInboundParser requires appSecret')
    }
    this.appSecret = config.appSecret
  }

  async parse(input: InboundWebhookInput): Promise<ParsedInboundMessage[]> {
    const raw = toBuffer(input.body)
    verifyXHubSignature256('Messenger', raw, input.headers['x-hub-signature-256'], this.appSecret)

    const payload = decodeJson('Messenger', raw)
    const out: ParsedInboundMessage[] = []

    for (const entry of arrayProp(payload, 'entry')) {
      for (const event of arrayProp(entry, 'messaging')) {
        const message = objectProp(event, 'message')
        if (!message) continue
        if (message.is_echo === true) continue

        const sender = objectProp(event, 'sender')
        const psid = sender ? stringProp(sender, 'id') : undefined
        const mid = stringProp(message, 'mid')
        if (!psid || !mid) continue

        const text = stringProp(message, 'text')
        const media = mapAttachments(arrayProp(message, 'attachments'))
        const timestamp = numberProp(event, 'timestamp')

        out.push({
          provider: 'messenger',
          conversationId: psid,
          fromUserId: psid,
          text,
          media,
          providerMessageId: mid,
          receivedAt: timestamp ? new Date(timestamp) : new Date(),
          raw: payload,
        })
      }
    }

    return out
  }
}

const MESSENGER_ATTACHMENT_KINDS: Record<string, MessagingMediaKind> = {
  image: 'image',
  audio: 'audio',
  video: 'video',
  file: 'file',
}

function mapAttachments(attachments: Record<string, unknown>[]): MessagingMedia[] {
  const result: MessagingMedia[] = []
  for (const att of attachments) {
    const type = stringProp(att, 'type')
    if (!type) continue
    const kind = MESSENGER_ATTACHMENT_KINDS[type]
    if (!kind) continue
    const payload = objectProp(att, 'payload')
    const media: MessagingMedia = { kind }
    const url = payload ? stringProp(payload, 'url') : undefined
    if (url) media.url = url
    const id = payload ? stringProp(payload, 'attachment_id') : undefined
    if (id) media.mediaId = id
    result.push(media)
  }
  return result
}

function decodeJson(service: string, body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf-8'))
  } catch (err) {
    throw new ExternalServiceError(service, 400, `Invalid JSON payload: ${(err as Error).message}`)
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
