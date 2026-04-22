import { describe, expect, test } from 'bun:test'
import {
  ImapInboundDriver,
  type ImapClientLike,
  type MailboxLockLike,
} from '../src/mail/inbound/imap_driver.ts'

interface FakeMessage {
  uid: number
  source: Buffer
}

class FakeImapClient implements ImapClientLike {
  connectCalls = 0
  logoutCalls = 0
  lockReleases = 0
  flaggedSeen: number[] = []
  fetchedUids: number[] = []

  constructor(
    private readonly inbox: FakeMessage[],
    private readonly opts: {
      connectThrows?: boolean
      fetchFailsFor?: Set<number>
    } = {}
  ) {}

  async connect(): Promise<void> {
    this.connectCalls++
    if (this.opts.connectThrows) throw new Error('connection refused')
  }

  async logout(): Promise<void> {
    this.logoutCalls++
  }

  async getMailboxLock(_path: string): Promise<MailboxLockLike> {
    return { release: () => { this.lockReleases++ } }
  }

  async search(): Promise<number[] | false> {
    return this.inbox.map(m => m.uid)
  }

  async fetchOne(uid: number | string): Promise<{ source?: Buffer } | false | null> {
    const n = typeof uid === 'string' ? parseInt(uid, 10) : uid
    this.fetchedUids.push(n)
    if (this.opts.fetchFailsFor?.has(n)) throw new Error('fetch failed')
    const msg = this.inbox.find(m => m.uid === n)
    return msg ? { source: msg.source } : null
  }

  async messageFlagsAdd(uid: number | string, flags: string[]): Promise<boolean> {
    const n = typeof uid === 'string' ? parseInt(uid, 10) : uid
    if (flags.includes('\\Seen')) this.flaggedSeen.push(n)
    return true
  }
}

function rfc822(from: string, to: string, subject: string, messageId: string, body: string): Buffer {
  return Buffer.from(
    [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: ${subject}`,
      `Message-ID: <${messageId}>`,
      '',
      body,
    ].join('\r\n'),
    'utf-8'
  )
}

describe('ImapInboundDriver', () => {
  test('processes each UNSEEN message, marks \\Seen after handler succeeds', async () => {
    const fake = new FakeImapClient([
      { uid: 1, source: rfc822('a@ex.com', 's@ex.com', 'one', 'msg-1@ex.com', 'body one') },
      { uid: 2, source: rfc822('b@ex.com', 's@ex.com', 'two', 'msg-2@ex.com', 'body two') },
    ])
    const driver = new ImapInboundDriver(
      { host: 'imap.test', auth: { user: 'u', pass: 'p' } },
      () => fake
    )

    const delivered: string[] = []
    const result = await driver.poll(async mail => {
      delivered.push(mail.subject)
    })

    expect(delivered).toEqual(['one', 'two'])
    expect(fake.flaggedSeen).toEqual([1, 2])
    expect(result).toEqual({ processed: 2, failed: 0, skipped: 0 })
    expect(fake.connectCalls).toBe(1)
    expect(fake.logoutCalls).toBe(1)
    expect(fake.lockReleases).toBe(1)
  })

  test('does NOT mark \\Seen when the handler throws — message retries next cycle', async () => {
    const fake = new FakeImapClient([
      { uid: 7, source: rfc822('a@ex.com', 's@ex.com', 'fails', 'fail@ex.com', 'body') },
    ])
    const driver = new ImapInboundDriver(
      { host: 'imap.test', auth: { user: 'u', pass: 'p' } },
      () => fake
    )

    const result = await driver.poll(async () => {
      throw new Error('db temporarily unavailable')
    })

    expect(result).toEqual({ processed: 0, failed: 1, skipped: 0 })
    expect(fake.flaggedSeen).toEqual([])
  })

  test('counts fetch failures as skipped, leaves them unread, continues with remaining', async () => {
    const fake = new FakeImapClient(
      [
        { uid: 1, source: rfc822('a@ex.com', 's@ex.com', 'one', '1@ex.com', 'b') },
        { uid: 2, source: rfc822('b@ex.com', 's@ex.com', 'two', '2@ex.com', 'b') },
      ],
      { fetchFailsFor: new Set([1]) }
    )
    const driver = new ImapInboundDriver(
      { host: 'imap.test', auth: { user: 'u', pass: 'p' } },
      () => fake
    )

    const delivered: string[] = []
    const result = await driver.poll(async mail => { delivered.push(mail.subject) })

    expect(delivered).toEqual(['two'])
    expect(fake.flaggedSeen).toEqual([2])
    expect(result.processed).toBe(1)
    expect(result.failed).toBe(1)
  })

  test('dryRun does not mark \\Seen even on handler success', async () => {
    const fake = new FakeImapClient([
      { uid: 1, source: rfc822('a@ex.com', 's@ex.com', 'dry', 'd@ex.com', 'b') },
    ])
    const driver = new ImapInboundDriver(
      { host: 'imap.test', auth: { user: 'u', pass: 'p' }, dryRun: true },
      () => fake
    )

    const result = await driver.poll(async () => {})
    expect(result.processed).toBe(1)
    expect(fake.flaggedSeen).toEqual([])
  })

  test('batchSize caps the number of messages processed per cycle', async () => {
    const fake = new FakeImapClient(
      Array.from({ length: 10 }, (_, i) => ({
        uid: i + 1,
        source: rfc822('a@ex.com', 's@ex.com', `m${i}`, `m${i}@ex.com`, 'b'),
      }))
    )
    const driver = new ImapInboundDriver(
      { host: 'imap.test', auth: { user: 'u', pass: 'p' }, batchSize: 3 },
      () => fake
    )

    const result = await driver.poll(async () => {})

    expect(result.processed).toBe(3)
    expect(fake.flaggedSeen).toEqual([1, 2, 3])
  })

  test('connection failure propagates to caller (scheduler will retry next tick)', async () => {
    const fake = new FakeImapClient([], { connectThrows: true })
    const driver = new ImapInboundDriver(
      { host: 'imap.test', auth: { user: 'u', pass: 'p' } },
      () => fake
    )

    await expect(driver.poll(async () => {})).rejects.toThrow('connection refused')
  })

  test('releases the mailbox lock even if a handler throws repeatedly', async () => {
    const fake = new FakeImapClient([
      { uid: 1, source: rfc822('a@ex.com', 's@ex.com', '1', '1@ex.com', 'b') },
      { uid: 2, source: rfc822('b@ex.com', 's@ex.com', '2', '2@ex.com', 'b') },
    ])
    const driver = new ImapInboundDriver(
      { host: 'imap.test', auth: { user: 'u', pass: 'p' } },
      () => fake
    )

    await driver.poll(async () => { throw new Error('fail') })

    expect(fake.lockReleases).toBe(1)
    expect(fake.logoutCalls).toBe(1)
  })

  test('empty inbox returns zero-counts without errors', async () => {
    const fake = new FakeImapClient([])
    const driver = new ImapInboundDriver(
      { host: 'imap.test', auth: { user: 'u', pass: 'p' } },
      () => fake
    )

    const result = await driver.poll(async () => {})
    expect(result).toEqual({ processed: 0, failed: 0, skipped: 0 })
  })

  test('throws ConfigurationError when host is missing', () => {
    expect(
      () =>
        new ImapInboundDriver(
          { host: '', auth: { user: 'u', pass: 'p' } },
          () => new FakeImapClient([])
        )
    ).toThrow('host required')
  })
})
