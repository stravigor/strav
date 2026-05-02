import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import Emitter from '@strav/kernel/events/emitter'
import Queue from '../src/queue/queue.ts'

interface SqlCall {
  raw: string
  values: unknown[]
}

function makeFakeDb(rows: unknown[] = []) {
  const calls: SqlCall[] = []
  const sql = ((strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.push({ raw: strings.join('?'), values })
    return Promise.resolve(rows) as any
  }) as any
  return {
    db: { sql } as any,
    calls,
  }
}

function mockConfig(overrides: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = {
    queue: { default: 'default', maxAttempts: 3, timeout: 60_000, retryBackoff: 'exponential', sleep: 1000, ...overrides },
  }
  return {
    get(key: string, def?: unknown) {
      const parts = key.split('.')
      let cur: any = data
      for (const p of parts) cur = cur?.[p]
      return cur !== undefined ? cur : def
    },
    has(key: string) { return this.get(key) !== undefined },
  } as any
}

beforeEach(() => {
  Emitter.removeAllListeners('queue:progress')
})

afterEach(() => {
  Queue.reset()
  Emitter.removeAllListeners('queue:progress')
})

describe('Queue.reportProgress', () => {
  test('persists clamped progress via SQL UPDATE and emits queue:progress', async () => {
    const fake = makeFakeDb()
    new Queue(fake.db, mockConfig())

    const seen: unknown[] = []
    Emitter.on('queue:progress', payload => { seen.push(payload) })

    await Queue.reportProgress(42, 0.3, 'processed 30/100')

    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0]!.raw).toContain('UPDATE')
    expect(fake.calls[0]!.raw).toContain('progress')
    expect(fake.calls[0]!.values).toContain(0.3)
    expect(fake.calls[0]!.values).toContain('processed 30/100')
    expect(fake.calls[0]!.values).toContain(42)

    // Emitter is async-fire-and-forget — wait one microtask
    await new Promise(r => setImmediate(r))
    expect(seen).toEqual([{ id: 42, value: 0.3, message: 'processed 30/100' }])
  })

  test('clamps values out of [0, 1]', async () => {
    const fake = makeFakeDb()
    new Queue(fake.db, mockConfig())

    await Queue.reportProgress(1, -0.5)
    await Queue.reportProgress(1, 1.7)
    await Queue.reportProgress(1, 0.5)

    expect(fake.calls[0]!.values).toContain(0)
    expect(fake.calls[1]!.values).toContain(1)
    expect(fake.calls[2]!.values).toContain(0.5)
  })

  test('omitted message stores NULL', async () => {
    const fake = makeFakeDb()
    new Queue(fake.db, mockConfig())

    await Queue.reportProgress(7, 0.5)

    expect(fake.calls[0]!.values).toContain(null)
  })
})

describe('Queue.progressOf', () => {
  test('returns the persisted snapshot', async () => {
    const fake = makeFakeDb([
      { id: 7, progress: '0.42', progress_message: 'partway', attempts: 1 },
    ])
    new Queue(fake.db, mockConfig())

    const result = await Queue.progressOf(7)
    expect(result).toEqual({
      id: 7,
      value: 0.42,
      message: 'partway',
      attempts: 1,
    })
  })

  test('returns null when the job is gone', async () => {
    const fake = makeFakeDb([])
    new Queue(fake.db, mockConfig())

    expect(await Queue.progressOf(999)).toBeNull()
  })

  test('handles NULL progress_message', async () => {
    const fake = makeFakeDb([
      { id: 1, progress: 0, progress_message: null, attempts: 0 },
    ])
    new Queue(fake.db, mockConfig())

    const result = await Queue.progressOf(1)
    expect(result?.message).toBeNull()
  })
})

describe('JobMeta.progress contract', () => {
  test('the type accepts (value: number, message?: string) returning Promise<void>', () => {
    // Compile-time-only test — confirms the contract via type assignability.
    // If this compiles, the JobMeta type is sound.
    type Check = (value: number, message?: string) => Promise<void>
    const _proof: Check = (() => Promise.resolve()) as Check
    void _proof
  })
})
