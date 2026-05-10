import { describe, expect, test } from 'bun:test'
import { MemoryMailTransport } from '../src/mail/transports/memory_transport.ts'

describe('MemoryMailTransport', () => {
  test('captures sent messages with metadata and a stable shape', async () => {
    const transport = new MemoryMailTransport()

    const result = await transport.send({
      from: 'noreply@example.com',
      to: 'alice@example.com',
      subject: 'Welcome',
      text: 'hello',
    })

    expect(result.messageId).toMatch(/^mem-/)
    expect(result.accepted).toEqual(['alice@example.com'])

    const all = transport.all()
    expect(all).toHaveLength(1)
    expect(all[0]!.subject).toBe('Welcome')
    expect(all[0]!.to).toBe('alice@example.com')
    expect(all[0]!.receivedAt).toBeInstanceOf(Date)
    expect(all[0]!.messageId).toBe(result.messageId)
  })

  test('filter narrows by recipient and subject regex', async () => {
    const transport = new MemoryMailTransport()
    await transport.send({ from: 'a', to: 'alice@example.com', subject: 'Welcome Alice' })
    await transport.send({ from: 'a', to: 'bob@example.com', subject: 'Welcome Bob' })
    await transport.send({ from: 'a', to: 'alice@example.com', subject: 'Receipt' })

    const aliceWelcomes = transport.filter({ to: 'alice@example.com', subject: /^Welcome/ })
    expect(aliceWelcomes.map(m => m.subject)).toEqual(['Welcome Alice'])
  })

  test('lastFor matches cc and bcc recipients, not just to', async () => {
    const transport = new MemoryMailTransport()
    await transport.send({ from: 'a', to: 'main@example.com', cc: 'cc@example.com', subject: 'cc-test' })
    await transport.send({ from: 'a', to: 'main@example.com', bcc: ['bcc@example.com'], subject: 'bcc-test' })

    expect(transport.lastFor('cc@example.com')?.subject).toBe('cc-test')
    expect(transport.lastFor('bcc@example.com')?.subject).toBe('bcc-test')
    expect(transport.lastFor('nobody@example.com')).toBeUndefined()
  })

  test('waitFor resolves when a matching mail arrives later', async () => {
    const transport = new MemoryMailTransport()
    setTimeout(() => {
      void transport.send({
        from: 'a',
        to: 'late@example.com',
        subject: 'Magic link',
        text: 'visit https://example.com/auth/verify?token=abc123',
      })
    }, 40)

    const mail = await transport.waitFor(
      { to: 'late@example.com', subject: /Magic/ },
      { timeout: 1000, interval: 10 },
    )
    expect(mail.subject).toBe('Magic link')
  })

  test('waitFor rejects on timeout when no matching mail arrives', async () => {
    const transport = new MemoryMailTransport()
    await expect(
      transport.waitFor({ to: 'nobody@example.com' }, { timeout: 60, interval: 10 }),
    ).rejects.toThrow(/timed out/)
  })

  test('extractLink and lastMagicLinkFor pull URLs from html or text bodies', async () => {
    const transport = new MemoryMailTransport()
    await transport.send({
      from: 'a',
      to: 'user@example.com',
      subject: 'Sign in',
      html: '<a href="https://example.com/auth/verify?token=xyz789&redirect=/home">Click</a>',
    })

    const link = transport.lastMagicLinkFor('user@example.com')
    expect(link).toContain('token=xyz789')
    expect(link).toContain('https://example.com/auth/verify')
  })

  test('lastMagicLinkFor honors a custom token param name', async () => {
    const transport = new MemoryMailTransport()
    await transport.send({
      from: 'a',
      to: 'user@example.com',
      subject: 'Sign in',
      text: 'visit https://example.com/auth/verify?code=secret',
    })

    expect(transport.lastMagicLinkFor('user@example.com')).toBeUndefined()
    expect(transport.lastMagicLinkFor('user@example.com', { tokenParam: 'code' })).toContain('code=secret')
  })

  test('ring buffer drops oldest beyond maxSize', async () => {
    const transport = new MemoryMailTransport({ maxSize: 2 })
    await transport.send({ from: 'a', to: 'x@example.com', subject: '1' })
    await transport.send({ from: 'a', to: 'x@example.com', subject: '2' })
    await transport.send({ from: 'a', to: 'x@example.com', subject: '3' })

    expect(transport.all().map(m => m.subject)).toEqual(['2', '3'])
  })

  test('clear empties the buffer', async () => {
    const transport = new MemoryMailTransport()
    await transport.send({ from: 'a', to: 'x@example.com', subject: 's' })
    transport.clear()
    expect(transport.all()).toHaveLength(0)
  })
})
