import { ExternalServiceError } from '@strav/kernel'
import type { MailTransport, MailMessage, MailResult, MailgunConfig } from '../types.ts'

/**
 * Mailgun HTTP API transport.
 * Uses fetch with FormData — no SDK dependency required.
 *
 * @see https://documentation.mailgun.com/docs/mailgun/api-reference/openapi-final/tag/Messages/
 */
export class MailgunTransport implements MailTransport {
  private apiKey: string
  private domain: string
  private baseUrl: string

  constructor(config: MailgunConfig) {
    this.apiKey = config.apiKey
    this.domain = config.domain
    this.baseUrl = config.baseUrl ?? 'https://api.mailgun.net'
  }

  async send(message: MailMessage): Promise<MailResult> {
    const form = new FormData()

    form.append('from', message.from)
    form.append('subject', message.subject)

    const toArray = Array.isArray(message.to) ? message.to : [message.to]
    form.append('to', toArray.join(', '))

    if (message.cc) {
      const ccArray = Array.isArray(message.cc) ? message.cc : [message.cc]
      form.append('cc', ccArray.join(', '))
    }
    if (message.bcc) {
      const bccArray = Array.isArray(message.bcc) ? message.bcc : [message.bcc]
      form.append('bcc', bccArray.join(', '))
    }
    if (message.replyTo) form.append('h:Reply-To', message.replyTo)
    if (message.html) form.append('html', message.html)
    if (message.text) form.append('text', message.text)

    if (message.attachments?.length) {
      for (const a of message.attachments) {
        const content =
          typeof a.content === 'string'
            ? new Blob([a.content], { type: a.contentType ?? 'application/octet-stream' })
            : new Blob([a.content], { type: a.contentType ?? 'application/octet-stream' })

        if (a.cid) {
          form.append('inline', content, a.filename)
        } else {
          form.append('attachment', content, a.filename)
        }
      }
    }

    const credentials = btoa(`api:${this.apiKey}`)
    const response = await fetch(`${this.baseUrl}/v3/${this.domain}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
      },
      body: form,
    })

    if (!response.ok) {
      const error = await response.text()
      throw new ExternalServiceError('Mailgun', response.status, error)
    }

    const data = (await response.json()) as { id: string }
    return { messageId: data.id, accepted: toArray }
  }
}
