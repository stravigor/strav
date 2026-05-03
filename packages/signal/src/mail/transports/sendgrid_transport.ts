import { ExternalServiceError, scrubProviderError } from '@strav/kernel'
import type { MailTransport, MailMessage, MailResult, SendGridConfig } from '../types.ts'

/**
 * SendGrid v3 Mail Send API transport.
 * Uses fetch — no SDK dependency required.
 *
 * @see https://docs.sendgrid.com/api-reference/mail-send/mail-send
 */
export class SendGridTransport implements MailTransport {
  private apiKey: string
  private baseUrl: string

  constructor(config: SendGridConfig) {
    this.apiKey = config.apiKey
    this.baseUrl = config.baseUrl ?? 'https://api.sendgrid.com/v3'
  }

  async send(message: MailMessage): Promise<MailResult> {
    const toArray = Array.isArray(message.to) ? message.to : [message.to]

    const personalizations: Record<string, unknown>[] = [
      {
        to: toArray.map(email => ({ email })),
      },
    ]

    if (message.cc) {
      const ccArray = Array.isArray(message.cc) ? message.cc : [message.cc]
      personalizations[0]!.cc = ccArray.map(email => ({ email }))
    }
    if (message.bcc) {
      const bccArray = Array.isArray(message.bcc) ? message.bcc : [message.bcc]
      personalizations[0]!.bcc = bccArray.map(email => ({ email }))
    }

    const content: { type: string; value: string }[] = []
    if (message.text) content.push({ type: 'text/plain', value: message.text })
    if (message.html) content.push({ type: 'text/html', value: message.html })

    const body: Record<string, unknown> = {
      personalizations,
      from: { email: message.from },
      subject: message.subject,
      content,
    }

    if (message.replyTo) body.reply_to = { email: message.replyTo }

    if (message.attachments?.length) {
      body.attachments = message.attachments.map(a => ({
        filename: a.filename,
        content:
          typeof a.content === 'string'
            ? Buffer.from(a.content).toString('base64')
            : Buffer.from(a.content).toString('base64'),
        type: a.contentType,
        disposition: a.cid ? 'inline' : 'attachment',
        content_id: a.cid,
      }))
    }

    const response = await fetch(`${this.baseUrl}/mail/send`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      const error = await response.text()
      throw new ExternalServiceError('SendGrid', response.status, scrubProviderError(error))
    }

    const messageId = response.headers.get('X-Message-Id') ?? undefined
    return { messageId, accepted: toArray }
  }
}
