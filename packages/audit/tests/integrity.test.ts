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
      for (const p of parts) cur = cur?.[p]
      return cur !== undefined ? cur : def
    },
    has(key: string) {
      return this.get(key) !== undefined
    },
  } as any
}

let store: MemoryAuditDriver

beforeEach(() => {
  EncryptionManager.useKey('test-app-key-for-audit')
  new AuditManager(mockConfig())
  store = new MemoryAuditDriver()
  AuditManager.useStore(store)
})

afterEach(() => {
  AuditManager.reset()
})

describe('verifyChain', () => {
  test('passes for an unmodified chain of 10 events', async () => {
    for (let i = 0; i < 10; i++) {
      await audit.by({ type: 'user', id: 'u1' }).on('lead', String(i)).action('created').log()
    }
    const result = await verifyChain()
    expect(result).toEqual({ ok: true, checked: 10 })
  })

  test('detects tampered metadata via mismatched hash', async () => {
    for (let i = 0; i < 5; i++) {
      await audit.by({ type: 'user', id: 'u1' }).on('lead', String(i)).action('created').log()
    }
    // Tamper with row 3's metadata; its stored hash will no longer match
    const events: any[] = []
    for await (const e of store.walk()) events.push(e)
    events[2].metadata = { tampered: true }

    const result = await verifyChain()
    expect(result.ok).toBe(false)
    expect(result.brokenAt).toBe(3)
  })

  test('detects swapped prev_hash linkage', async () => {
    for (let i = 0; i < 4; i++) {
      await audit.by({ type: 'user', id: 'u1' }).on('lead', String(i)).action('created').log()
    }
    const events: any[] = []
    for await (const e of store.walk()) events.push(e)
    // Break the link: row 3 now claims its prev was row 1's hash instead of row 2's
    events[2].prevHash = events[0].hash

    const result = await verifyChain()
    expect(result.ok).toBe(false)
    expect(result.brokenAt).toBe(3)
  })

  test('walk respects from/to bounds', async () => {
    for (let i = 0; i < 6; i++) {
      await audit.by({ type: 'user', id: 'u1' }).on('lead', String(i)).action('created').log()
    }
    const result = await verifyChain({ from: 2, to: 4 })
    expect(result).toEqual({ ok: true, checked: 3 })
  })

  test('passes on an empty chain', async () => {
    const result = await verifyChain()
    expect(result).toEqual({ ok: true, checked: 0 })
  })
})
