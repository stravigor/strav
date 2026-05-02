import { ConfigurationError, ExternalServiceError } from '@strav/kernel'
import type {
  MessagingMedia,
  MessagingMessage,
  MessagingResult,
  MessagingTransport,
  WhatsAppConfig,
} from '../types.ts'

/**
 * WhatsApp Cloud API (Meta Graph API) outbound transport.
 *
 * Sends messages via POST {baseUrl}/{phoneNumberId}/messages with a Bearer
 * token. Text and one or more media attachments are supported. When `replyTo`
 * is set, the API receives `context.message_id` so the message renders as a
 * reply. Each media item produces a separate API call (Cloud API has no
 * batch endpoint), and the first response's WAMID is returned.
 *
 * Media handling: pass `url` for the provider to fetch, or pre-upload via
 * /{phoneNumberId}/media and pass the returned `mediaId`. This transport
 * does not perform uploads — keep that responsibility in the caller so
 * upload failure is observable independently of send.
 *
 * @see https://developers.facebook.com/docs/whatsapp/cloud-api/reference/messages
 */
export class WhatsAppTransport implements MessagingTransport {
  readonly name = 'whatsapp'
  private readonly phoneNumberId: string
  private readonly accessToken: string
  private readonly baseUrl: string

  constructor(config: WhatsAppConfig) {
    if (!config.accessToken) {
      throw new ConfigurationError('WhatsAppTransport requires accessToken')
    }
    if (!config.phoneNumberId) {
      throw new ConfigurationError('WhatsAppTransport requires phoneNumberId')
    }
    this.phoneNumberId = config.phoneNumberId
    this.accessToken = config.accessToken
    this.baseUrl = config.baseUrl ?? 'https://graph.facebook.com/v20.0'
  }

  async send(message: MessagingMessage): Promise<MessagingResult> {
    if (!message.text && !message.media?.length) {
      throw new ExternalServiceError('WhatsApp', 400, 'Message must include text or media')
    }

    const bodies: Record<string, unknown>[] = []
    if (message.text) {
      bodies.push(this.buildTextBody(message.to, message.text, message.replyTo))
    }
    for (const media of message.media ?? []) {
      bodies.push(this.buildMediaBody(message.to, media, message.replyTo))
    }

    let firstId: string | undefined
    let firstRaw: unknown
    for (const body of bodies) {
      const response = await fetch(`${this.baseUrl}/${this.phoneNumberId}/messages`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      })

      const raw = await readJson(response)
      if (!response.ok) {
        throw new ExternalServiceError('WhatsApp', response.status, formatError(raw))
      }
      const id = extractMessageId(raw)
      firstId ??= id
      firstRaw ??= raw
    }

    return { providerMessageId: firstId, raw: firstRaw }
  }

  private buildTextBody(to: string, text: string, replyTo?: string): Record<string, unknown> {
    const body: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { body: text, preview_url: false },
    }
    if (replyTo) body.context = { message_id: replyTo }
    return body
  }

  private buildMediaBody(to: string, media: MessagingMedia, replyTo?: string): Record<string, unknown> {
    const type = whatsappMediaType(media.kind)
    const ref: Record<string, unknown> = media.mediaId ? { id: media.mediaId } : { link: media.url }
    if (media.caption && type !== 'audio') ref.caption = media.caption
    if (type === 'document' && media.filename) ref.filename = media.filename

    const body: Record<string, unknown> = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type,
      [type]: ref,
    }
    if (replyTo) body.context = { message_id: replyTo }
    return body
  }
}

function whatsappMediaType(kind: MessagingMedia['kind']): 'image' | 'audio' | 'video' | 'document' {
  return kind === 'file' ? 'document' : kind
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

function extractMessageId(raw: unknown): string | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const messages = (raw as Record<string, unknown>).messages
  if (Array.isArray(messages) && messages[0] && typeof messages[0] === 'object') {
    const id = (messages[0] as Record<string, unknown>).id
    if (typeof id === 'string') return id
  }
  return undefined
}

function formatError(raw: unknown): string {
  if (!raw) return 'Empty response'
  if (typeof raw === 'string') return raw
  if (typeof raw === 'object' && 'error' in (raw as object)) {
    const err = (raw as Record<string, unknown>).error
    if (err && typeof err === 'object') {
      const msg = (err as Record<string, unknown>).message
      if (typeof msg === 'string') return msg
    }
  }
  return JSON.stringify(raw)
}
