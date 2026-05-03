import { ConfigurationError, ExternalServiceError } from '@strav/kernel'
import type { InboundWebhookInput } from '../../mail/inbound/types.ts'
import type { MessagingMedia, MessagingMediaKind } from '../types.ts'
import type { InboundMessageParser, ParsedInboundMessage } from './types.ts'
import { toBuffer, verifyXHubSignature256 } from './signature.ts'

/**
 * Parse a WhatsApp Cloud API inbound webhook payload.
 *
 * Authentication is X-Hub-Signature-256 (HMAC-SHA256 over the raw body using
 * the app secret). Webhook envelopes are heavily nested:
 * `entry[].changes[].value.messages[]` carries actual messages; status
 * updates and other events are skipped.
 *
 * Media references arrive as IDs only — the caller fetches bytes via
 * GET /{mediaId} using the same access token used for sending.
 *
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/payload-examples
 */
export class WhatsAppInboundParser implements InboundMessageParser {
  private readonly appSecret: string

  constructor(config: { appSecret: string }) {
    if (!config.appSecret) {
      throw new ConfigurationError('WhatsAppInboundParser requires appSecret')
    }
    this.appSecret = config.appSecret
  }

  async parse(input: InboundWebhookInput): Promise<ParsedInboundMessage[]> {
    const raw = toBuffer(input.body)
    verifyXHubSignature256('WhatsApp', raw, input.headers['x-hub-signature-256'], this.appSecret)

    const payload = decodeJson('WhatsApp', raw)
    const out: ParsedInboundMessage[] = []

    const entries = arrayProp(payload, 'entry')
    for (const entry of entries) {
      const changes = arrayProp(entry, 'changes')
      for (const change of changes) {
        const value = objectProp(change, 'value')
        if (!value) continue
        const contacts = arrayProp(value, 'contacts')
        const messages = arrayProp(value, 'messages')
        for (const msg of messages) {
          const parsed = this.toParsed(msg, contacts, payload)
          if (parsed) out.push(parsed)
        }
      }
    }

    return out
  }

  private toParsed(
    msg: Record<string, unknown>,
    contacts: Record<string, unknown>[],
    raw: unknown
  ): ParsedInboundMessage | null {
    const from = stringProp(msg, 'from')
    const id = stringProp(msg, 'id')
    const type = stringProp(msg, 'type')
    if (!from || !id || !type) return null

    const profile = contacts.find(c => stringProp(c, 'wa_id') === from)
    const profileName = profile
      ? stringProp(objectProp(profile, 'profile') ?? {}, 'name')
      : undefined

    const text = type === 'text' ? stringProp(objectProp(msg, 'text') ?? {}, 'body') : undefined
    const media = mapMedia(type, msg)

    return {
      provider: 'whatsapp',
      conversationId: from,
      fromUserId: from,
      fromName: profileName,
      text,
      media,
      providerMessageId: id,
      receivedAt: parseTimestampSeconds(stringProp(msg, 'timestamp')),
      raw,
    }
  }
}

const WHATSAPP_MEDIA_FIELDS: Record<string, MessagingMediaKind> = {
  image: 'image',
  audio: 'audio',
  voice: 'audio',
  video: 'video',
  document: 'file',
  sticker: 'image',
}

function mapMedia(type: string, msg: Record<string, unknown>): MessagingMedia[] {
  const kind = WHATSAPP_MEDIA_FIELDS[type]
  if (!kind) return []
  const media = objectProp(msg, type)
  if (!media) return []
  const item: MessagingMedia = { kind }
  const id = stringProp(media, 'id')
  if (id) item.mediaId = id
  const filename = stringProp(media, 'filename')
  if (filename) item.filename = sanitizeFilename(filename)
  const contentType = stringProp(media, 'mime_type')
  if (contentType) item.contentType = contentType
  const caption = stringProp(media, 'caption')
  if (caption) item.caption = caption
  return [item]
}

/**
 * Strip path separators and anchor characters from a WhatsApp-supplied
 * filename. The sender controls this string; if a downstream consumer
 * uses it as a filesystem / S3 key path component, traversal is
 * possible without sanitization. We keep the basename, normalize
 * unsafe characters to `_`, and cap the length so a malicious sender
 * can't fill the DB with a 1MB filename either.
 */
function sanitizeFilename(raw: string): string {
  // Take the basename — drop any directory path the sender wedged in.
  const segments = raw.split(/[/\\]/)
  let name = segments[segments.length - 1] ?? ''
  // Strip null bytes and replace any character that isn't alphanumeric,
  // dot, dash, underscore, or space.
  name = name.replace(/\0/g, '').replace(/[^a-zA-Z0-9._\- ]/g, '_')
  // Strip leading dots so we don't end up with `.htaccess`-shaped names.
  name = name.replace(/^\.+/, '')
  // Cap length — 255 is the typical filesystem limit; we use 200 to
  // leave headroom for downstream prefixing.
  if (name.length > 200) name = name.slice(0, 200)
  return name || 'unnamed'
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

function parseTimestampSeconds(value: string | undefined): Date {
  if (!value) return new Date()
  const seconds = Number(value)
  if (!Number.isFinite(seconds)) return new Date()
  return new Date(seconds * 1000)
}
