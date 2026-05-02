import { ConfigurationError, ExternalServiceError } from '@strav/kernel'
import type {
  MessagingMedia,
  MessagingMessage,
  MessagingResult,
  MessagingTransport,
  MessengerConfig,
} from '../types.ts'

/**
 * Facebook Messenger Send API outbound transport.
 *
 * POSTs to {baseUrl}/me/messages?access_token=... with the recipient's
 * Page-Scoped ID (PSID) and a message envelope. Text and media attachments
 * are sent as separate API calls; the first message's mid is returned.
 *
 * `replyTo` is ignored: Messenger has no first-class reply primitive in the
 * Send API outside conversational components, which are out of scope for the
 * first iteration.
 *
 * @see https://developers.facebook.com/docs/messenger-platform/send-messages
 */
export class MessengerTransport implements MessagingTransport {
  readonly name = 'messenger'
  private readonly pageAccessToken: string
  private readonly baseUrl: string

  constructor(config: MessengerConfig) {
    if (!config.pageAccessToken) {
      throw new ConfigurationError('MessengerTransport requires pageAccessToken')
    }
    this.pageAccessToken = config.pageAccessToken
    this.baseUrl = config.baseUrl ?? 'https://graph.facebook.com/v20.0'
  }

  async send(message: MessagingMessage): Promise<MessagingResult> {
    if (!message.text && !message.media?.length) {
      throw new ExternalServiceError('Messenger', 400, 'Message must include text or media')
    }

    const bodies: Record<string, unknown>[] = []
    if (message.text) {
      bodies.push(this.buildEnvelope(message.to, { text: message.text }))
    }
    for (const media of message.media ?? []) {
      bodies.push(this.buildEnvelope(message.to, this.buildAttachment(media)))
    }

    const url = `${this.baseUrl}/me/messages?access_token=${encodeURIComponent(this.pageAccessToken)}`

    let firstId: string | undefined
    let firstRaw: unknown
    for (const body of bodies) {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const raw = await readJson(response)
      if (!response.ok) {
        throw new ExternalServiceError('Messenger', response.status, formatError(raw))
      }
      const id = extractMessageId(raw)
      firstId ??= id
      firstRaw ??= raw
    }

    return { providerMessageId: firstId, raw: firstRaw }
  }

  private buildEnvelope(psid: string, message: Record<string, unknown>): Record<string, unknown> {
    return {
      recipient: { id: psid },
      messaging_type: 'RESPONSE',
      message,
    }
  }

  private buildAttachment(media: MessagingMedia): Record<string, unknown> {
    const type = messengerAttachmentType(media.kind)
    const payload: Record<string, unknown> = { is_reusable: false }
    if (media.url) payload.url = media.url
    if (media.mediaId) payload.attachment_id = media.mediaId
    return { attachment: { type, payload } }
  }
}

function messengerAttachmentType(kind: MessagingMedia['kind']): 'image' | 'audio' | 'video' | 'file' {
  return kind
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
  const id = (raw as Record<string, unknown>).message_id
  return typeof id === 'string' ? id : undefined
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
