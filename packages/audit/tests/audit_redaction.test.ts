import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { EncryptionManager } from '@strav/kernel'
import AuditManager from '../src/audit_manager.ts'
import { audit } from '../src/helpers.ts'
import { verifyChain } from '../src/integrity.ts'
import { MemoryAuditDriver } from '../src/drivers/memory_driver.ts'

function mockConfig(overrides: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = { audit: { driver: 'memory', chain: true, ...overrides } }
  return {
    get(key: string, def?: unknown) {
      const parts = key.split('.')
      let cur: any = data
      for (const p of parts) {
        if (cur === undefined || cur === null) return def
        cur = cur[p]
      }
      return cur !== undefined ? cur : def
    },
    has(key: string) {
      return this.get(key) !== undefined
    },
  } as any
}

let store: MemoryAuditDriver

beforeEach(() => {
  EncryptionManager.useKey('test-app-key-for-audit-redaction')
  // Construct manager FIRST — its constructor populates _config and
  // overwrites the active store. Then swap in the in-memory driver
  // we want for assertions.
  new AuditManager(mockConfig())
  store = new MemoryAuditDriver()
  AuditManager.useStore(store)
})

afterEach(() => {
  AuditManager.reset()
})

describe('AuditManager.append redaction', () => {
  test('scrubs sensitive keys in metadata', async () => {
    await audit
      .by({ type: 'user', id: '1' })
      .on('user', '1')
      .action('login')
      .meta({ password: 'p4ss', userAgent: 'curl/7.0', authorization: 'Bearer abc' })
      .log()

    const events = await store.range({})
    expect(events).toHaveLength(1)
    const meta = events[0]!.metadata as Record<string, unknown>
    expect(meta.password).toBe('[REDACTED]')
    expect(meta.authorization).toBe('[REDACTED]')
    expect(meta.userAgent).toBe('curl/7.0')
  })

  test('scrubs sensitive keys recursively inside metadata', async () => {
    await audit
      .by({ type: 'user', id: '1' })
      .on('account', '42')
      .action('updated')
      .meta({ request: { headers: { authorization: 'Bearer xyz', accept: 'json' } } })
      .log()

    const events = await store.range({})
    const request = (events[0]!.metadata as any).request
    expect(request.headers.authorization).toBe('[REDACTED]')
    expect(request.headers.accept).toBe('json')
  })

  test('scrubs sensitive keys in diff added/removed/changed', async () => {
    await audit
      .by({ type: 'user', id: '1' })
      .on('account', '42')
      .action('updated')
      .diff(
        { name: 'A', api_key: 'old-key' },
        { name: 'B', api_key: 'new-key', token: 't' }
      )
      .log()

    const events = await store.range({})
    const diff = events[0]!.diff as any
    expect(diff.changed.name).toEqual({ before: 'A', after: 'B' })
    // api_key existed on both sides → in `changed`, both before/after redacted
    expect(diff.changed.api_key.before).toBe('[REDACTED]')
    expect(diff.changed.api_key.after).toBe('[REDACTED]')
    // token only on the right → in `added`, value redacted
    expect(diff.added.token).toBe('[REDACTED]')
  })

  test('scrubs sensitive keys in diff removed (left-only)', async () => {
    await audit
      .by({ type: 'user', id: '1' })
      .on('account', '42')
      .action('updated')
      .diff({ name: 'A', secret: 'gone' }, { name: 'A' })
      .log()

    const events = await store.range({})
    const diff = events[0]!.diff as any
    expect(diff.removed.secret).toBe('[REDACTED]')
  })

  test('chain integrity holds after redaction', async () => {
    await audit
      .by({ type: 'user', id: '1' })
      .on('account', '42')
      .action('login')
      .meta({ password: 'p4ss' })
      .log()
    await audit
      .by({ type: 'user', id: '1' })
      .on('account', '42')
      .action('updated')
      .diff({ token: 'old' }, { token: 'new' })
      .log()
    await audit
      .by({ type: 'user', id: '1' })
      .on('account', '42')
      .action('viewed')
      .log()

    const result = await verifyChain()
    expect(result.ok).toBe(true)
    expect(result.checked).toBe(3)
    expect(result.brokenAt).toBeUndefined()
  })

  test('benign metadata passes through unchanged', async () => {
    await audit
      .by({ type: 'user', id: '1' })
      .on('order', '99')
      .action('created')
      .meta({ source: 'web', currency: 'USD', amount: 1234 })
      .log()

    const events = await store.range({})
    const meta = events[0]!.metadata as Record<string, unknown>
    expect(meta.source).toBe('web')
    expect(meta.currency).toBe('USD')
    expect(meta.amount).toBe(1234)
  })
})
