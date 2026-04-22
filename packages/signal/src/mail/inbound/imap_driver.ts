import { ConfigurationError } from '@strav/kernel'
import { parseRawMail } from './raw_mail_parser.ts'
import type {
  ImapInboundConfig,
  InboundMailHandler,
  PollResult,
} from './types.ts'

/**
 * Minimal subset of imapflow's ImapFlow API used by ImapInboundDriver.
 * Exposed so tests (or alternative IMAP clients) can be swapped in via
 * the ImapInboundDriver constructor's second argument.
 */
export interface ImapClientLike {
  connect(): Promise<void>
  logout(): Promise<void>
  getMailboxLock(path: string): Promise<MailboxLockLike>
  search(criteria: Record<string, unknown>, opts?: { uid?: boolean }): Promise<number[] | false>
  fetchOne(
    uid: number | string,
    query: Record<string, unknown>,
    opts?: { uid?: boolean }
  ): Promise<{ source?: Buffer } | false | null>
  messageFlagsAdd(
    uid: number | string,
    flags: string[],
    opts?: { uid?: boolean }
  ): Promise<boolean>
}

export interface MailboxLockLike {
  release: () => void
}

export type ImapClientFactory = (config: ImapInboundConfig) => ImapClientLike

/**
 * IMAP inbound driver. One `poll()` = one connect/search/fetch/logout cycle.
 *
 * Typical wiring is via mail.poll(), which schedules poll() on a cron and
 * prevents overlapping runs. Call poll() directly if you need manual control
 * (e.g. from a CLI command).
 *
 * Error semantics per cycle:
 *   - Connection or auth failure: throws — the scheduler logs and retries
 *     on the next tick.
 *   - Individual message fetch failure: counted as skipped, NOT marked \Seen.
 *   - Handler throws for a message: counted as failed, NOT marked \Seen — so
 *     the next cycle retries. Make handlers idempotent.
 *   - Handler succeeds: message is marked \Seen before moving to the next.
 */
export class ImapInboundDriver {
  private readonly config: ImapInboundConfig
  private readonly createClient: ImapClientFactory

  constructor(config: ImapInboundConfig, createClient?: ImapClientFactory) {
    if (!config.host) throw new ConfigurationError('ImapInboundDriver: host required')
    if (!config.auth) throw new ConfigurationError('ImapInboundDriver: auth required')
    this.config = config
    this.createClient = createClient ?? defaultImapFlowFactory
  }

  async poll(onMail: InboundMailHandler): Promise<PollResult> {
    const client = this.createClient(this.config)
    const mailbox = this.config.mailbox ?? 'INBOX'
    const batchSize = this.config.batchSize ?? 50
    const result: PollResult = { processed: 0, failed: 0, skipped: 0 }

    await client.connect()
    try {
      const lock = await client.getMailboxLock(mailbox)
      try {
        const uids = await client.search({ seen: false }, { uid: true })
        if (!uids || uids.length === 0) return result

        for (const uid of uids.slice(0, batchSize)) {
          try {
            const msg = await client.fetchOne(uid, { source: true }, { uid: true })
            if (!msg || !msg.source) {
              result.skipped++
              continue
            }

            const parsed = await parseRawMail(msg.source)
            await onMail(parsed)

            if (!this.config.dryRun) {
              await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true })
            }
            result.processed++
          } catch {
            // Intentionally swallow — message stays UNSEEN for next cycle retry.
            result.failed++
          }
        }
      } finally {
        lock.release()
      }
    } finally {
      try {
        await client.logout()
      } catch {
        // Logout failures are non-fatal; the connection will time out server-side.
      }
    }

    return result
  }
}

/**
 * Lazy factory: imports imapflow only if the default client is used. This keeps
 * the dependency optional — if a consumer supplies their own factory (tests,
 * alternate client), imapflow is never loaded.
 */
const defaultImapFlowFactory: ImapClientFactory = config => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { ImapFlow } = require('imapflow') as typeof import('imapflow')
  return new ImapFlow({
    host: config.host,
    port: config.port ?? 993,
    secure: config.secure ?? true,
    auth: config.auth,
    logger: false,
    tls: config.tls,
  }) as unknown as ImapClientLike
}
