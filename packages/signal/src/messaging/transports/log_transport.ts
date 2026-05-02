import type {
  LogMessagingConfig,
  MessagingMessage,
  MessagingResult,
  MessagingTransport,
} from '../types.ts'

/**
 * Development/testing transport — logs message details to console or a file.
 * No external dependencies required.
 */
export class LogMessagingTransport implements MessagingTransport {
  readonly name = 'log'
  private readonly output: 'console' | string

  constructor(config: LogMessagingConfig) {
    this.output = config.output ?? 'console'
  }

  async send(message: MessagingMessage): Promise<MessagingResult> {
    const timestamp = new Date().toISOString()
    const separator = '─'.repeat(60)

    const lines = [
      separator,
      `[Messaging:log] ${timestamp}`,
      `To:       ${message.to}`,
    ]
    if (message.replyTo) lines.push(`Reply-To: ${message.replyTo}`)
    if (message.text) lines.push('', '--- Text ---', message.text)
    if (message.media?.length) {
      lines.push('', `--- Media (${message.media.length}) ---`)
      for (const m of message.media) {
        const ref = m.url ?? `id:${m.mediaId ?? '(none)'}`
        lines.push(`  [${m.kind}] ${ref}${m.caption ? ` — ${m.caption}` : ''}`)
      }
    }
    lines.push(separator, '')

    const out = lines.join('\n')
    if (this.output === 'console') {
      console.log(out)
    } else {
      const file = Bun.file(this.output)
      const existing = (await file.exists()) ? await file.text() : ''
      await Bun.write(this.output, existing + out + '\n')
    }

    const id = `log-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    return { providerMessageId: id }
  }
}
