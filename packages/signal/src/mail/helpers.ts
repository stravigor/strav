import MailManager from './mail_manager.ts'
import { ViewEngine } from '@strav/view'
import { inlineCss } from './css_inliner.ts'
import { Queue } from '@strav/queue'
import type { MailMessage, MailResult, MailAttachment } from './types.ts'

/**
 * Fluent email builder. Returned by `mail.to()`.
 *
 * @example
 * await mail.to('user@example.com')
 *   .subject('Welcome!')
 *   .template('welcome', { name: 'Alice' })
 *   .send()
 *
 * await mail.to(user.email)
 *   .from('support@app.com')
 *   .subject('Reset Password')
 *   .template('reset', { token })
 *   .queue()
 */
export class PendingMail {
  private _from?: string
  private _to: string | string[]
  private _cc?: string | string[]
  private _bcc?: string | string[]
  private _replyTo?: string
  private _subject = ''
  private _html?: string
  private _text?: string
  private _attachments: MailAttachment[] = []
  private _template?: string
  private _templateData?: Record<string, unknown>

  constructor(to: string | string[]) {
    this._to = to
  }

  from(address: string): this {
    this._from = address
    return this
  }

  cc(address: string | string[]): this {
    this._cc = address
    return this
  }

  bcc(address: string | string[]): this {
    this._bcc = address
    return this
  }

  replyTo(address: string): this {
    this._replyTo = address
    return this
  }

  subject(value: string): this {
    this._subject = value
    return this
  }

  /** Set raw HTML content (bypasses template rendering). */
  html(value: string): this {
    this._html = value
    return this
  }

  /** Set plain text content. */
  text(value: string): this {
    this._text = value
    return this
  }

  /** Use a .strav template. Name is relative to the mail template prefix. */
  template(name: string, data: Record<string, unknown> = {}): this {
    this._template = name
    this._templateData = data
    return this
  }

  attach(attachment: MailAttachment): this {
    this._attachments.push(attachment)
    return this
  }

  /** Build the MailMessage, rendering template + inlining CSS if needed. */
  async build(): Promise<MailMessage> {
    const config = MailManager.config
    let html = this._html
    const text = this._text

    if (this._template) {
      const templateName = `${config.templatePrefix}.${this._template}`
      html = await ViewEngine.instance.render(templateName, this._templateData ?? {})
    }

    if (html) {
      html = await inlineCss(html, {
        enabled: config.inlineCss,
        tailwind: config.tailwind,
      })
    }

    return {
      from: this._from ?? config.from,
      to: this._to,
      cc: this._cc,
      bcc: this._bcc,
      replyTo: this._replyTo,
      subject: this._subject,
      html,
      text,
      attachments: this._attachments.length > 0 ? this._attachments : undefined,
    }
  }

  /** Send the email immediately via the configured transport. */
  async send(): Promise<MailResult> {
    const message = await this.build()
    return MailManager.transport.send(message)
  }

  /** Push the email onto the job queue for async sending. */
  async queue(options?: { queue?: string; delay?: number }): Promise<number> {
    const message = await this.build()
    return Queue.push('strav:send-mail', message, options)
  }
}

/**
 * Mail helper object — the primary API for sending emails.
 *
 * @example
 * import { mail } from '@strav/signal/mail'
 *
 * // Fluent builder
 * await mail.to('user@example.com').subject('Hello').template('welcome', { name }).send()
 *
 * // Convenience send
 * await mail.send({ to: 'user@example.com', subject: 'Hello', template: 'welcome', data: { name } })
 *
 * // Raw HTML send
 * await mail.raw({ to: 'user@example.com', subject: 'Hello', html: '<h1>Hi</h1>' })
 */
export const mail = {
  /** Start building an email to the given recipient(s). Returns a fluent PendingMail. */
  to(address: string | string[]): PendingMail {
    return new PendingMail(address)
  },

  /** Send an email using a template. Convenience wrapper for the fluent API. */
  async send(options: {
    to: string | string[]
    from?: string
    cc?: string | string[]
    bcc?: string | string[]
    replyTo?: string
    subject: string
    template: string
    data?: Record<string, unknown>
    attachments?: MailAttachment[]
  }): Promise<MailResult> {
    const pending = new PendingMail(options.to)
      .subject(options.subject)
      .template(options.template, options.data)
    if (options.from) pending.from(options.from)
    if (options.cc) pending.cc(options.cc)
    if (options.bcc) pending.bcc(options.bcc)
    if (options.replyTo) pending.replyTo(options.replyTo)
    if (options.attachments) {
      for (const a of options.attachments) pending.attach(a)
    }
    return pending.send()
  },

  /** Send a raw email without template rendering. */
  async raw(options: {
    to: string | string[]
    from?: string
    cc?: string | string[]
    bcc?: string | string[]
    replyTo?: string
    subject: string
    html?: string
    text?: string
    attachments?: MailAttachment[]
  }): Promise<MailResult> {
    const pending = new PendingMail(options.to).subject(options.subject)
    if (options.from) pending.from(options.from)
    if (options.html) pending.html(options.html)
    if (options.text) pending.text(options.text)
    if (options.cc) pending.cc(options.cc)
    if (options.bcc) pending.bcc(options.bcc)
    if (options.replyTo) pending.replyTo(options.replyTo)
    if (options.attachments) {
      for (const a of options.attachments) pending.attach(a)
    }
    return pending.send()
  },

  /**
   * Register the built-in queue handler for async mail sending.
   * Call this in your app bootstrap after Queue is configured.
   */
  registerQueueHandler(): void {
    Queue.handle<MailMessage>('strav:send-mail', async message => {
      await MailManager.transport.send(message)
    })
  },
}
