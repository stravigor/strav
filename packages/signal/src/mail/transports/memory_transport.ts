import type { MailTransport, MailMessage, MailResult } from '../types.ts'

export interface CapturedMail extends MailMessage {
  receivedAt: Date
  messageId: string
}

export interface MailQuery {
  to?: string
  subject?: RegExp | string
  since?: Date
}

export interface MemoryTransportOptions {
  /** Cap on retained messages; oldest are dropped beyond this. Default: 100. */
  maxSize?: number
}

export interface WaitForOptions {
  /** Total wait budget in ms. Default: 5000. */
  timeout?: number
  /** Poll interval in ms. Default: 25. */
  interval?: number
}

/**
 * In-memory mail transport for tests and local development. Captures every
 * sent message into a ring buffer and exposes a query/poll API so tests can
 * assert on outgoing mail or follow magic-link URLs without a real inbox.
 */
export class MemoryMailTransport implements MailTransport {
  private buffer: CapturedMail[] = []
  private readonly maxSize: number

  constructor(options: MemoryTransportOptions = {}) {
    this.maxSize = options.maxSize ?? 100
  }

  async send(message: MailMessage): Promise<MailResult> {
    const messageId = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
    this.buffer.push({ ...message, receivedAt: new Date(), messageId })
    if (this.buffer.length > this.maxSize) this.buffer.shift()
    const accepted = Array.isArray(message.to) ? [...message.to] : [message.to]
    return { messageId, accepted }
  }

  /** All captured messages, oldest first. Caller must not mutate. */
  all(): readonly CapturedMail[] {
    return this.buffer
  }

  filter(query: MailQuery): CapturedMail[] {
    return this.buffer.filter(mail => matches(mail, query))
  }

  /** Most recent message addressed to `email` (matches `to`/`cc`/`bcc`). */
  lastFor(email: string): CapturedMail | undefined {
    for (let i = this.buffer.length - 1; i >= 0; i--) {
      if (recipientMatches(this.buffer[i]!, email)) return this.buffer[i]
    }
    return undefined
  }

  /** Resolve once a captured mail matches the query; reject on timeout. */
  async waitFor(query: MailQuery, options: WaitForOptions = {}): Promise<CapturedMail> {
    const timeout = options.timeout ?? 5000
    const interval = options.interval ?? 25
    const deadline = Date.now() + timeout

    // Fast path — already captured.
    const existing = this.buffer.find(mail => matches(mail, query))
    if (existing) return existing

    return await new Promise<CapturedMail>((resolve, reject) => {
      const tick = (): void => {
        const hit = this.buffer.find(mail => matches(mail, query))
        if (hit) {
          resolve(hit)
          return
        }
        if (Date.now() >= deadline) {
          reject(new Error(`MemoryMailTransport.waitFor timed out after ${timeout}ms (query=${JSON.stringify(query)})`))
          return
        }
        setTimeout(tick, interval)
      }
      setTimeout(tick, interval)
    })
  }

  /** Extract the first URL matching `pattern` from a captured mail's html or text body. */
  extractLink(mail: CapturedMail, pattern: RegExp): string | null {
    const haystack = (mail.html ?? '') + '\n' + (mail.text ?? '')
    const match = haystack.match(pattern)
    return match ? match[0] : null
  }

  /**
   * Convenience: latest captured magic-link URL for `email`. Looks for any URL
   * containing `?<tokenParam>=…` (default tokenParam = 'token') in the html or
   * text body of the most recent matching message.
   */
  lastMagicLinkFor(email: string, options: { tokenParam?: string } = {}): string | undefined {
    const param = options.tokenParam ?? 'token'
    const mail = this.lastFor(email)
    if (!mail) return undefined
    const escaped = param.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(`https?:\\/\\/[^\\s"'<>]+[?&]${escaped}=[^\\s"'<>&]+`)
    return this.extractLink(mail, pattern) ?? undefined
  }

  clear(): void {
    this.buffer.length = 0
  }
}

function recipientMatches(mail: CapturedMail, email: string): boolean {
  const recipients = [
    ...toArray(mail.to),
    ...toArray(mail.cc),
    ...toArray(mail.bcc),
  ]
  return recipients.includes(email)
}

function matches(mail: CapturedMail, query: MailQuery): boolean {
  if (query.to !== undefined && !recipientMatches(mail, query.to)) return false
  if (query.subject !== undefined) {
    if (query.subject instanceof RegExp) {
      if (!query.subject.test(mail.subject)) return false
    } else if (mail.subject !== query.subject) {
      return false
    }
  }
  if (query.since !== undefined && mail.receivedAt < query.since) return false
  return true
}

function toArray(value: string | string[] | undefined): string[] {
  if (!value) return []
  return Array.isArray(value) ? value : [value]
}
