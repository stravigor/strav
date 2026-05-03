import { ExternalServiceError, scrubProviderError } from '@strav/kernel'
import type { MailTransport, MailMessage, MailResult, ResendConfig } from '../types.ts'

/**
 * Resend HTTP API transport.
 * Uses fetch — no SDK dependency required.
 *
 * @see https://resend.com/docs/api-reference/emails/send-email
 */
export class ResendTransport implements MailTransport {
  private apiKey: string
  private baseUrl: string

  constructor(config: ResendConfig) {
    this.apiKey = config.apiKey
    this.baseUrl = config.baseUrl ?? 'https://api.resend.com'
  }

  async send(message: MailMessage): Promise<MailResult> {
    const body: Record<string, unknown> = {
      from: message.from,
      to: Array.isArray(message.to) ? message.to : [message.to],
      subject: message.subject,
    }

    if (message.cc) body.cc = Array.isArray(message.cc) ? message.cc : [message.cc]
    if (message.bcc) body.bcc = Array.isArray(message.bcc) ? message.bcc : [message.bcc]
    if (message.replyTo) body.reply_to = message.replyTo
    if (message.html) body.html = message.html
    if (message.text) body.text = message.text

    if (message.attachments?.length) {
      body.attachments = message.attachments.map(a => ({
        filename: a.filename,
        content:
          typeof a.content === 'string' ? a.content : Buffer.from(a.content).toString('base64'),
        content_type: a.contentType,
      }))
    }

    const response = await fetch(`${this.baseUrl}/emails`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new ExternalServiceError('Resend', response.status, scrubProviderError(error))
    }

    const data = (await response.json()) as { id: string }
    return { messageId: data.id }
  }
}
