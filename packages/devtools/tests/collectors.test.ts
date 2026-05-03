import { test, expect, describe, beforeEach, afterEach } from 'bun:test'
import { Emitter } from '@strav/kernel'
import { compose } from '@strav/http'
import type { Handler, Middleware } from '@strav/http'
import RequestCollector from '../src/collectors/request_collector.ts'
import ExceptionCollector from '../src/collectors/exception_collector.ts'
import LogCollector from '../src/collectors/log_collector.ts'
import JobCollector from '../src/collectors/job_collector.ts'
import Collector from '../src/collectors/collector.ts'
import { MockEntryStore, ctx, wait } from './helpers.ts'

// ---------------------------------------------------------------------------
// Collector base class
// ---------------------------------------------------------------------------

describe('Collector (base)', () => {
  let store: MockEntryStore

  beforeEach(() => {
    store = new MockEntryStore()
  })

  test('record() buffers entries when enabled', () => {
    const collector = new TestCollector(store, { enabled: true })
    collector.doRecord('request', 'batch-1', { path: '/test' }, ['tag1'])

    expect(collector.queueLength).toBe(1)
  })

  test('record() does nothing when disabled', () => {
    const collector = new TestCollector(store, { enabled: false })
    collector.doRecord('request', 'batch-1', { path: '/test' })

    expect(collector.queueLength).toBe(0)
  })

  test('flush() writes buffered entries to store', async () => {
    const collector = new TestCollector(store, { enabled: true })
    collector.doRecord('request', 'batch-1', { path: '/a' })
    collector.doRecord('request', 'batch-1', { path: '/b' })

    await collector.flush()

    expect(store.entries).toHaveLength(2)
    expect(store.entries[0]!.content.path).toBe('/a')
    expect(store.entries[1]!.content.path).toBe('/b')
  })

  test('flush() clears the queue', async () => {
    const collector = new TestCollector(store, { enabled: true })
    collector.doRecord('request', 'batch-1', { path: '/a' })
    await collector.flush()

    expect(collector.queueLength).toBe(0)
  })

  test('hash() produces consistent MD5 hex strings', () => {
    const collector = new TestCollector(store, { enabled: true })
    const h1 = collector.doHash('SELECT * FROM users')
    const h2 = collector.doHash('SELECT * FROM users')
    const h3 = collector.doHash('SELECT * FROM posts')

    expect(h1).toBe(h2)
    expect(h1).not.toBe(h3)
    expect(h1).toMatch(/^[0-9a-f]{32}$/)
  })

  test('entries include uuid, batchId, and createdAt', async () => {
    const collector = new TestCollector(store, { enabled: true })
    collector.doRecord('log', 'batch-42', { msg: 'hi' }, ['info'])
    await collector.flush()

    const entry = store.entries[0]!
    expect(entry.uuid).toMatch(/^[0-9a-f-]{36}$/)
    expect(entry.batchId).toBe('batch-42')
    expect(entry.type).toBe('log')
    expect(entry.tags).toEqual(['info'])
    expect(entry.createdAt).toBeInstanceOf(Date)
  })
})

// Concrete subclass for testing protected methods
class TestCollector extends Collector {
  register(): void {}
  teardown(): void {}

  doRecord(
    type: any,
    batchId: string,
    content: Record<string, unknown>,
    tags?: string[],
    familyHash?: string | null
  ): void {
    this.record(type, batchId, content, tags, familyHash ?? null)
  }

  doHash(input: string): string {
    return this.hash(input)
  }

  get queueLength(): number {
    return this.queue.length
  }
}

// ---------------------------------------------------------------------------
// RequestCollector
// ---------------------------------------------------------------------------

describe('RequestCollector', () => {
  let store: MockEntryStore

  beforeEach(() => {
    store = new MockEntryStore()
  })

  test('middleware records request data', async () => {
    const collector = new RequestCollector(store, { enabled: true, sizeLimit: 64 })
    const mw = collector.middleware()

    const handler: Handler = c => c.json({ ok: true })

    const c = ctx('http://localhost/api/users', 'GET')
    await compose([mw as Middleware], handler)(c)

    // Give the fire-and-forget flush time to complete
    await wait(50)

    expect(store.entries).toHaveLength(1)
    const entry = store.entries[0]!
    expect(entry.type).toBe('request')
    expect(entry.content.method).toBe('GET')
    expect(entry.content.path).toBe('/api/users')
    expect(entry.content.status).toBe(200)
    expect(typeof entry.content.duration).toBe('number')
  })

  test('middleware sets batchId on context', async () => {
    const collector = new RequestCollector(store, { enabled: true })
    const mw = collector.middleware()

    let batchId: string | undefined

    const handler: Handler = c => {
      batchId = c.get<string>('_devtools_batch_id')
      return c.text('ok')
    }

    await compose([mw as Middleware], handler)(ctx())
    await wait(50)

    expect(batchId).toBeDefined()
    expect(batchId).toMatch(/^[0-9a-f-]{36}$/)
  })

  test('middleware does nothing when disabled', async () => {
    const collector = new RequestCollector(store, { enabled: false })
    const mw = collector.middleware()

    const handler: Handler = c => c.text('ok')
    await compose([mw as Middleware], handler)(ctx())
    await wait(50)

    expect(store.entries).toHaveLength(0)
  })

  test('middleware redacts sensitive request headers', async () => {
    const collector = new RequestCollector(store, { enabled: true })
    const mw = collector.middleware()

    const handler: Handler = c => c.text('ok')
    const c = ctx('http://localhost/', 'GET', {
      authorization: 'Bearer secret-token',
      cookie: 'sid=xyz',
      'x-api-key': 'sk-abc123',
      'x-csrf-token': 'csrf-tok',
      accept: 'application/json',
    })
    await compose([mw as Middleware], handler)(c)
    await wait(50)

    const headers = store.entries[0]!.content.requestHeaders as Record<string, string>
    expect(headers.authorization).toBe('[REDACTED]')
    expect(headers.cookie).toBe('[REDACTED]')
    expect(headers['x-api-key']).toBe('[REDACTED]')
    expect(headers['x-csrf-token']).toBe('[REDACTED]')
    expect(headers.accept).toBe('application/json')
  })

  test('middleware respects redactKeys option for app-specific headers', async () => {
    const collector = new RequestCollector(store, {
      enabled: true,
      redactKeys: ['x-internal-tenant'],
    })
    const mw = collector.middleware()

    const handler: Handler = c => c.text('ok')
    const c = ctx('http://localhost/', 'GET', {
      'x-internal-tenant': 'tenant-42',
      'x-other': 'public',
    })
    await compose([mw as Middleware], handler)(c)
    await wait(50)

    const headers = store.entries[0]!.content.requestHeaders as Record<string, string>
    expect(headers['x-internal-tenant']).toBe('[REDACTED]')
    expect(headers['x-other']).toBe('public')
  })

  test('middleware tags slow requests', async () => {
    const collector = new RequestCollector(store, { enabled: true })
    const mw = collector.middleware()

    // Handler that takes > 1 second (we'll mock it)
    const handler: Handler = async c => {
      await Bun.sleep(5)
      return c.text('ok')
    }

    await compose([mw as Middleware], handler)(ctx())
    await wait(50)

    // The 5ms handler won't trigger "slow" tag (needs > 1000ms)
    const entry = store.entries[0]!
    expect(entry.tags).toContain('status:200')
    expect(entry.tags).not.toContain('slow')
  })

  test('middleware tags authenticated user', async () => {
    const collector = new RequestCollector(store, { enabled: true })
    const mw = collector.middleware()

    const authMiddleware: Middleware = (c, next) => {
      c.set('user', { id: 42 })
      return next()
    }

    const handler: Handler = c => c.text('ok')
    await compose([authMiddleware, mw as Middleware], handler)(ctx())
    await wait(50)

    expect(store.entries[0]!.tags).toContain('user:42')
  })
})

// ---------------------------------------------------------------------------
// ExceptionCollector
// ---------------------------------------------------------------------------

describe('ExceptionCollector', () => {
  let store: MockEntryStore
  let collector: ExceptionCollector

  beforeEach(() => {
    store = new MockEntryStore()
    Emitter.removeAllListeners('http:error')
  })

  afterEach(() => {
    collector?.teardown()
    Emitter.removeAllListeners('http:error')
  })

  test('captures http:error events', async () => {
    collector = new ExceptionCollector(store, { enabled: true }, () => 'batch-1')
    collector.register()

    const error = new TypeError('Cannot read property x of null')
    await Emitter.emit('http:error', { error, ctx: { path: '/api/data', method: 'GET' } })
    await collector.flush()
    await wait()

    expect(store.entries).toHaveLength(1)
    const entry = store.entries[0]!
    expect(entry.type).toBe('exception')
    expect(entry.content.class).toBe('TypeError')
    expect(entry.content.message).toBe('Cannot read property x of null')
    expect(entry.content.path).toBe('/api/data')
    expect(entry.content.method).toBe('GET')
    expect(entry.tags).toContain('TypeError')
    expect(entry.familyHash).toBeTruthy()
  })

  test('does nothing when disabled', async () => {
    collector = new ExceptionCollector(store, { enabled: false }, () => 'batch-1')
    collector.register()

    await Emitter.emit('http:error', { error: new Error('test'), ctx: {} })
    await collector.flush()

    expect(store.entries).toHaveLength(0)
  })

  test('teardown removes listener', async () => {
    collector = new ExceptionCollector(store, { enabled: true }, () => 'batch-1')
    collector.register()
    expect(Emitter.listenerCount('http:error')).toBe(1)

    collector.teardown()
    expect(Emitter.listenerCount('http:error')).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// LogCollector
// ---------------------------------------------------------------------------

describe('LogCollector', () => {
  let store: MockEntryStore
  let collector: LogCollector

  beforeEach(() => {
    store = new MockEntryStore()
    Emitter.removeAllListeners('log:entry')
  })

  afterEach(() => {
    collector?.teardown()
    Emitter.removeAllListeners('log:entry')
  })

  test('captures log:entry events at or above minimum level', async () => {
    collector = new LogCollector(store, { enabled: true, level: 'info' }, () => 'batch-1')
    collector.register()

    await Emitter.emit('log:entry', {
      level: 'info',
      msg: 'Server started',
      context: { port: 3000 },
    })
    await Emitter.emit('log:entry', { level: 'debug', msg: 'Debug message' })
    await Emitter.emit('log:entry', { level: 'error', msg: 'Something broke' })
    await collector.flush()

    expect(store.entries).toHaveLength(2) // info + error, not debug

    expect(store.entries[0]!.content.level).toBe('info')
    expect(store.entries[0]!.content.message).toBe('Server started')
    expect(store.entries[0]!.content.context).toEqual({ port: 3000 })

    expect(store.entries[1]!.content.level).toBe('error')
    expect(store.entries[1]!.tags).toContain('error')
  })

  test('captures all levels when set to trace', async () => {
    collector = new LogCollector(store, { enabled: true, level: 'trace' }, () => 'batch-1')
    collector.register()

    await Emitter.emit('log:entry', { level: 'trace', msg: 'Trace' })
    await Emitter.emit('log:entry', { level: 'debug', msg: 'Debug' })
    await Emitter.emit('log:entry', { level: 'info', msg: 'Info' })
    await collector.flush()

    expect(store.entries).toHaveLength(3)
  })

  test('default level is debug', async () => {
    collector = new LogCollector(store, { enabled: true }, () => 'batch-1')
    collector.register()

    await Emitter.emit('log:entry', { level: 'trace', msg: 'Trace' })
    await Emitter.emit('log:entry', { level: 'debug', msg: 'Debug' })
    await collector.flush()

    expect(store.entries).toHaveLength(1)
    expect(store.entries[0]!.content.level).toBe('debug')
  })

  test('tags error and fatal with "error"', async () => {
    collector = new LogCollector(store, { enabled: true, level: 'trace' }, () => 'batch-1')
    collector.register()

    await Emitter.emit('log:entry', { level: 'error', msg: 'Err' })
    await Emitter.emit('log:entry', { level: 'fatal', msg: 'Fatal' })
    await collector.flush()

    expect(store.entries[0]!.tags).toContain('error')
    expect(store.entries[1]!.tags).toContain('error')
  })

  test('redacts sensitive keys from log context', async () => {
    collector = new LogCollector(store, { enabled: true, level: 'trace' }, () => 'batch-1')
    collector.register()

    await Emitter.emit('log:entry', {
      level: 'info',
      msg: 'login attempt',
      context: {
        userId: 'u-1',
        password: 'p4ssw0rd',
        nested: { authorization: 'Bearer abc', ok: 'public' },
      },
    })
    await collector.flush()

    const ctx = store.entries[0]!.content.context as Record<string, unknown>
    expect(ctx.userId).toBe('u-1')
    expect(ctx.password).toBe('[REDACTED]')
    expect((ctx.nested as any).authorization).toBe('[REDACTED]')
    expect((ctx.nested as any).ok).toBe('public')
  })

  test('redactKeys option extends the deny-list per app', async () => {
    collector = new LogCollector(
      store,
      { enabled: true, level: 'trace', redactKeys: ['internalCode'] },
      () => 'batch-1'
    )
    collector.register()

    await Emitter.emit('log:entry', {
      level: 'info',
      msg: 'event',
      context: { internalCode: 'IC-42', name: 'event' },
    })
    await collector.flush()

    const ctx = store.entries[0]!.content.context as Record<string, unknown>
    expect(ctx.internalCode).toBe('[REDACTED]')
    expect(ctx.name).toBe('event')
  })
})

// ---------------------------------------------------------------------------
// JobCollector
// ---------------------------------------------------------------------------

describe('JobCollector', () => {
  let store: MockEntryStore
  let collector: JobCollector

  beforeEach(() => {
    store = new MockEntryStore()
    Emitter.removeAllListeners('queue:dispatched')
    Emitter.removeAllListeners('queue:processed')
    Emitter.removeAllListeners('queue:failed')
  })

  afterEach(() => {
    collector?.teardown()
    Emitter.removeAllListeners('queue:dispatched')
    Emitter.removeAllListeners('queue:processed')
    Emitter.removeAllListeners('queue:failed')
  })

  test('captures dispatched jobs', async () => {
    collector = new JobCollector(store, { enabled: true }, () => 'test-batch')
    collector.register()

    await Emitter.emit('queue:dispatched', {
      id: 1,
      name: 'send-email',
      queue: 'default',
      payload: { to: 'user@example.com' },
    })
    await wait(50)

    expect(store.entries).toHaveLength(1)
    const entry = store.entries[0]!
    expect(entry.type).toBe('job')
    expect(entry.content.status).toBe('dispatched')
    expect(entry.content.name).toBe('send-email')
    expect(entry.content.queue).toBe('default')
    expect(entry.tags).toContain('send-email')
    expect(entry.tags).toContain('dispatched')
  })

  test('captures processed jobs', async () => {
    collector = new JobCollector(store, { enabled: true }, () => 'test-batch')
    collector.register()

    await Emitter.emit('queue:processed', {
      job: 'send-email',
      id: 5,
      queue: 'emails',
      duration: 42.5,
    })
    await wait(50)

    expect(store.entries).toHaveLength(1)
    expect(store.entries[0]!.content.status).toBe('processed')
    expect(store.entries[0]!.content.duration).toBe(42.5)
    expect(store.entries[0]!.tags).toContain('processed')
  })

  test('captures failed jobs', async () => {
    collector = new JobCollector(store, { enabled: true }, () => 'test-batch')
    collector.register()

    await Emitter.emit('queue:failed', {
      job: 'process-payment',
      id: 8,
      queue: 'payments',
      error: 'Card declined',
      duration: 100,
    })
    await wait(50)

    expect(store.entries).toHaveLength(1)
    expect(store.entries[0]!.content.status).toBe('failed')
    expect(store.entries[0]!.content.error).toBe('Card declined')
    expect(store.entries[0]!.tags).toContain('failed')
  })

  test('teardown removes all listeners', () => {
    collector = new JobCollector(store, { enabled: true }, () => 'test-batch')
    collector.register()

    expect(Emitter.listenerCount('queue:dispatched')).toBe(1)
    expect(Emitter.listenerCount('queue:processed')).toBe(1)
    expect(Emitter.listenerCount('queue:failed')).toBe(1)

    collector.teardown()

    expect(Emitter.listenerCount('queue:dispatched')).toBe(0)
    expect(Emitter.listenerCount('queue:processed')).toBe(0)
    expect(Emitter.listenerCount('queue:failed')).toBe(0)
  })
})
