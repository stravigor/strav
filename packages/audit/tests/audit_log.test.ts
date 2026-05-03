import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { EncryptionManager } from '@strav/kernel'
import AuditManager from '../src/audit_manager.ts'
import { audit } from '../src/helpers.ts'
import { auditQuery } from '../src/queries.ts'
import { MemoryAuditDriver } from '../src/drivers/memory_driver.ts'

function mockConfig(
  overrides: Record<string, unknown> = {},
  appEnv: string = 'test'
) {
  const data: Record<string, unknown> = {
    app: { env: appEnv },
    audit: { driver: 'memory', chain: true, ...overrides },
  }
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

beforeEach(() => {
  EncryptionManager.useKey('test-app-key-for-audit')
  AuditManager.useStore(new MemoryAuditDriver())
  // Construct manager so _config is populated
  new AuditManager(mockConfig())
  // Use the freshly-instantiated driver
  AuditManager.useStore(new MemoryAuditDriver())
})

afterEach(() => {
  AuditManager.reset()
})

describe('audit.by()/.on()/.action()/.log()', () => {
  test('persists a fully-formed event with chain hash', async () => {
    const event = await audit
      .by({ type: 'user', id: 42 })
      .on('lead', '123')
      .action('qualified')
      .meta({ requestId: 'req-1' })
      .log()

    expect(event.id).toBe(1)
    expect(event.actorType).toBe('user')
    expect(event.actorId).toBe('42')
    expect(event.subjectType).toBe('lead')
    expect(event.subjectId).toBe('123')
    expect(event.action).toBe('qualified')
    expect(event.metadata).toEqual({ requestId: 'req-1' })
    expect(event.prevHash).toBeNull()
    expect(event.hash).toBeTruthy()
    expect(event.createdAt).toBeInstanceOf(Date)
  })

  test('chains subsequent events via prevHash', async () => {
    const a = await audit.by({ type: 'user', id: 1 }).on('lead', '1').action('created').log()
    const b = await audit.by({ type: 'user', id: 1 }).on('lead', '1').action('updated').log()
    const c = await audit.by({ type: 'user', id: 1 }).on('lead', '1').action('qualified').log()

    expect(b.prevHash).toBe(a.hash)
    expect(c.prevHash).toBe(b.hash)
    expect(new Set([a.hash, b.hash, c.hash]).size).toBe(3)
  })

  test('omits chain hashes when chain is disabled (non-prod env)', async () => {
    const originalWarn = console.warn
    const calls: unknown[][] = []
    console.warn = (...args: unknown[]) => calls.push(args)
    try {
      new AuditManager(mockConfig({ chain: false }, 'local'))
      AuditManager.useStore(new MemoryAuditDriver())

      const event = await audit.by({ type: 'user', id: 1 }).on('lead', '1').action('created').log()
      expect(event.hash).toBeUndefined()
      expect(event.prevHash).toBeNull()

      // A warning was emitted at boot — operators must see this in logs.
      expect(calls.length).toBeGreaterThan(0)
      const message = String(calls[0]?.[0] ?? '')
      expect(message).toContain('chain disabled')
    } finally {
      console.warn = originalWarn
    }
  })

  test('refuses to boot with chain=false in production', () => {
    expect(() => new AuditManager(mockConfig({ chain: false }, 'production'))).toThrow(
      /Refusing to boot with chain=false/
    )
  })

  test('refuses to boot with chain=false when app.env is unset (defaults to production)', () => {
    // Build a config that has no app.env key at all
    const data: Record<string, unknown> = { audit: { driver: 'memory', chain: false } }
    const cfg = {
      get(key: string, def?: unknown) {
        const parts = key.split('.')
        let cur: any = data
        for (const p of parts) {
          if (cur === undefined || cur === null) return def
          cur = cur[p]
        }
        return cur !== undefined ? cur : def
      },
    } as any
    expect(() => new AuditManager(cfg)).toThrow(/Refusing to boot with chain=false/)
  })

  test('accepts AuditActorLike objects via .by()', async () => {
    const actor = { auditActorType: () => 'api_key', auditActorId: () => 'sk_xyz' }
    const event = await audit.by(actor).on('contact', '99').action('imported').log()
    expect(event.actorType).toBe('api_key')
    expect(event.actorId).toBe('sk_xyz')
  })

  test('omits actor for system events', async () => {
    const event = await audit.on('lead', '1').action('expired').log()
    expect(event.actorType).toBeUndefined()
    expect(event.actorId).toBeUndefined()
  })

  test('.diff(before, after) computes the structural diff', async () => {
    const event = await audit
      .by({ type: 'user', id: 1 })
      .on('lead', '1')
      .action('updated')
      .diff({ name: 'Old', score: 10 }, { name: 'New', score: 20, status: 'qualified' })
      .log()

    expect(event.diff).toEqual({
      added: { status: 'qualified' },
      changed: {
        name: { before: 'Old', after: 'New' },
        score: { before: 10, after: 20 },
      },
    })
  })

  test('.diff(prebuilt) accepts a pre-computed AuditDiff', async () => {
    const event = await audit
      .by({ type: 'user', id: 1 })
      .on('lead', '1')
      .action('migrated')
      .diff({ added: { migrated: true } })
      .log()
    expect(event.diff).toEqual({ added: { migrated: true } })
  })

  test('.meta() merges across multiple calls', async () => {
    const event = await audit
      .by({ type: 'user', id: 1 })
      .on('lead', '1')
      .action('updated')
      .meta({ a: 1 })
      .meta({ b: 2 })
      .log()
    expect(event.metadata).toEqual({ a: 1, b: 2 })
  })

  test('throws when subject is missing', async () => {
    await expect(audit.by({ type: 'user', id: 1 }).action('x').log()).rejects.toThrow(
      /subject/i
    )
  })

  test('throws when action is missing', async () => {
    await expect(audit.by({ type: 'user', id: 1 }).on('lead', '1').log()).rejects.toThrow(
      /action/i
    )
  })
})

describe('auditQuery', () => {
  beforeEach(async () => {
    await audit.by({ type: 'user', id: 'u1' }).on('lead', 'l1').action('created').log()
    await audit.by({ type: 'user', id: 'u1' }).on('lead', 'l1').action('updated').log()
    await audit.by({ type: 'user', id: 'u2' }).on('lead', 'l2').action('created').log()
    await audit.by({ type: 'user', id: 'u1' }).on('contact', 'c1').action('created').log()
  })

  test('forSubject returns events for that subject in chronological order', async () => {
    const events = await auditQuery.forSubject('lead', 'l1').all()
    expect(events.map(e => e.action)).toEqual(['created', 'updated'])
  })

  test('forActor returns events by that actor across subjects', async () => {
    const events = await auditQuery.forActor('user', 'u1').all()
    expect(events.map(e => e.subjectType)).toEqual(['lead', 'lead', 'contact'])
  })

  test('actions filter narrows the result', async () => {
    const events = await auditQuery.forActor('user', 'u1').actions(['updated']).all()
    expect(events).toHaveLength(1)
    expect(events[0]!.action).toBe('updated')
  })

  test('limit caps the result', async () => {
    const events = await auditQuery.forActor('user', 'u1').limit(2).all()
    expect(events).toHaveLength(2)
  })

  test('range queries combine filters', async () => {
    const events = await auditQuery.range({ subjectType: 'lead' }).all()
    expect(events).toHaveLength(3)
  })
})
