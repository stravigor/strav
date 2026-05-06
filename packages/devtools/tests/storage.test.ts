import { test, expect, describe, beforeAll, beforeEach, afterAll } from 'bun:test'
import { join } from 'node:path'
import { Configuration } from '@strav/kernel'
import { Database } from '@strav/database'
import EntryStore from '../src/storage/entry_store.ts'
import AggregateStore from '../src/storage/aggregate_store.ts'
import type { DevtoolsEntry, EntryType } from '../src/types.ts'

// ---------------------------------------------------------------------------
// These tests require a running PostgreSQL database.
// They use the same connection as the core tests (config/database.ts).
// ---------------------------------------------------------------------------

let db: Database
let entryStore: EntryStore
let aggregateStore: AggregateStore

beforeAll(async () => {
  const config = new Configuration(join(import.meta.dir, '../config'))
  await config.load()
  db = new Database(config)
  await db.init()

  entryStore = new EntryStore(db.sql)
  aggregateStore = new AggregateStore(db.sql)

  // Create tables
  await entryStore.ensureTable()
  await aggregateStore.ensureTable()
})

beforeEach(async () => {
  // Clean tables between tests
  await db.sql`DELETE FROM "_strav_devtools_entries"`
  await db.sql`DELETE FROM "_strav_devtools_aggregates"`
})

afterAll(async () => {
  // Drop tables and close connection
  await db.sql.unsafe('DROP TABLE IF EXISTS "_strav_devtools_entries"')
  await db.sql.unsafe('DROP TABLE IF EXISTS "_strav_devtools_aggregates"')
  await db.close()
})

// ---------------------------------------------------------------------------
// EntryStore
// ---------------------------------------------------------------------------

describe('EntryStore', () => {
  function makeEntry(overrides: Partial<DevtoolsEntry> = {}): DevtoolsEntry {
    return {
      uuid: crypto.randomUUID(),
      batchId: crypto.randomUUID(),
      type: 'request' as EntryType,
      familyHash: null,
      content: { method: 'GET', path: '/test' },
      tags: ['status:200'],
      createdAt: new Date(),
      ...overrides,
    }
  }

  test('store and list entries', async () => {
    await entryStore.store([
      makeEntry({ content: { path: '/a' } }),
      makeEntry({ content: { path: '/b' } }),
    ])

    const entries = await entryStore.list()
    expect(entries).toHaveLength(2)
  })

  test('list filters by type', async () => {
    await entryStore.store([
      makeEntry({ type: 'request' }),
      makeEntry({ type: 'query' }),
      makeEntry({ type: 'request' }),
    ])

    const requests = await entryStore.list('request')
    expect(requests).toHaveLength(2)

    const queries = await entryStore.list('query')
    expect(queries).toHaveLength(1)
  })

  test('list respects limit and offset', async () => {
    for (let i = 0; i < 10; i++) {
      await entryStore.store([makeEntry({ content: { index: i } })])
    }

    const page1 = await entryStore.list(undefined, 3, 0)
    expect(page1).toHaveLength(3)

    const page2 = await entryStore.list(undefined, 3, 3)
    expect(page2).toHaveLength(3)
  })

  test('find by uuid', async () => {
    const uuid = crypto.randomUUID()
    await entryStore.store([makeEntry({ uuid, content: { found: true } })])

    const entry = await entryStore.find(uuid)
    expect(entry).not.toBeNull()
    expect(entry!.uuid).toBe(uuid)
    expect(entry!.content.found).toBe(true)
  })

  test('find returns null for unknown uuid', async () => {
    const entry = await entryStore.find(crypto.randomUUID())
    expect(entry).toBeNull()
  })

  test('batch returns all entries with same batchId', async () => {
    const batchId = crypto.randomUUID()
    await entryStore.store([
      makeEntry({ batchId, type: 'request', content: { path: '/test' } }),
      makeEntry({ batchId, type: 'query', content: { sql: 'SELECT 1' } }),
      makeEntry({ batchId, type: 'log', content: { msg: 'hello' } }),
      makeEntry({ content: { path: '/other' } }), // different batch
    ])

    const batch = await entryStore.batch(batchId)
    expect(batch).toHaveLength(3)
    expect(batch.every(e => e.batchId === batchId)).toBe(true)
  })

  test('byTag searches by tag', async () => {
    await entryStore.store([
      makeEntry({ tags: ['user:42', 'status:200'] }),
      makeEntry({ tags: ['user:99', 'status:200'] }),
      makeEntry({ tags: ['user:42', 'slow'] }),
    ])

    const user42 = await entryStore.byTag('user:42')
    expect(user42).toHaveLength(2)

    const slow = await entryStore.byTag('slow')
    expect(slow).toHaveLength(1)
  })

  test('count returns total and type-filtered counts', async () => {
    await entryStore.store([
      makeEntry({ type: 'request' }),
      makeEntry({ type: 'query' }),
      makeEntry({ type: 'query' }),
    ])

    expect(await entryStore.count()).toBe(3)
    expect(await entryStore.count('request')).toBe(1)
    expect(await entryStore.count('query')).toBe(2)
    expect(await entryStore.count('exception')).toBe(0)
  })

  test('prune deletes old entries', async () => {
    // Insert an entry "2 days ago"
    const old = makeEntry()
    old.createdAt = new Date(Date.now() - 48 * 3600 * 1000)
    await entryStore.store([old])

    // Insert a recent entry
    await entryStore.store([makeEntry()])

    const pruned = await entryStore.prune(24)
    expect(pruned).toBe(1)
    expect(await entryStore.count()).toBe(1)
  })

  test('stores and retrieves familyHash', async () => {
    const hash = 'abc123def456'
    await entryStore.store([makeEntry({ familyHash: hash })])

    const entries = await entryStore.list()
    expect(entries[0]!.familyHash).toBe(hash)
  })
})

// ---------------------------------------------------------------------------
// AggregateStore
// ---------------------------------------------------------------------------

describe('AggregateStore', () => {
  test('record creates aggregated buckets', async () => {
    await aggregateStore.record('slow_request', 'GET /api/users', 1500, ['count', 'max'])

    const counts = await aggregateStore.query('slow_request', 3600, 'count')
    expect(counts.length).toBeGreaterThan(0)
    expect(counts[0]!.value).toBe(1)

    const maxes = await aggregateStore.query('slow_request', 3600, 'max')
    expect(maxes.length).toBeGreaterThan(0)
    expect(Number(maxes[0]!.value)).toBe(1500)
  })

  test('record upserts — count accumulates', async () => {
    await aggregateStore.record('slow_query', 'SELECT *', 100, ['count'])
    await aggregateStore.record('slow_query', 'SELECT *', 200, ['count'])
    await aggregateStore.record('slow_query', 'SELECT *', 300, ['count'])

    const counts = await aggregateStore.query('slow_query', 3600, 'count')
    expect(counts.length).toBeGreaterThan(0)
    expect(Number(counts[0]!.value)).toBe(3)
  })

  test('max aggregate keeps highest value', async () => {
    await aggregateStore.record('slow_query', 'SELECT *', 100, ['max'])
    await aggregateStore.record('slow_query', 'SELECT *', 500, ['max'])
    await aggregateStore.record('slow_query', 'SELECT *', 200, ['max'])

    const maxes = await aggregateStore.query('slow_query', 3600, 'max')
    expect(Number(maxes[0]!.value)).toBe(500)
  })

  test('min aggregate keeps lowest value', async () => {
    await aggregateStore.record('slow_query', 'SELECT *', 300, ['min'])
    await aggregateStore.record('slow_query', 'SELECT *', 100, ['min'])
    await aggregateStore.record('slow_query', 'SELECT *', 500, ['min'])

    const mins = await aggregateStore.query('slow_query', 3600, 'min')
    expect(Number(mins[0]!.value)).toBe(100)
  })

  test('sum aggregate accumulates values', async () => {
    await aggregateStore.record('slow_query', 'SELECT *', 100, ['sum'])
    await aggregateStore.record('slow_query', 'SELECT *', 200, ['sum'])

    const sums = await aggregateStore.query('slow_query', 3600, 'sum')
    expect(Number(sums[0]!.value)).toBe(300)
  })

  test('topKeys returns keys ranked by value', async () => {
    await aggregateStore.record('slow_request', 'GET /fast', 100, ['count'])
    await aggregateStore.record('slow_request', 'GET /slow', 100, ['count'])
    await aggregateStore.record('slow_request', 'GET /slow', 100, ['count'])
    await aggregateStore.record('slow_request', 'GET /slow', 100, ['count'])

    const top = await aggregateStore.topKeys('slow_request', 3600, 'count', 10)
    expect(top.length).toBeGreaterThanOrEqual(2)
    // GET /slow should be first (count=3 vs count=1)
    expect(top[0]!.key).toBe('GET /slow')
  })

  test('prune deletes old aggregates', async () => {
    // Record something (creates buckets at current time)
    await aggregateStore.record('test_metric', 'key', 1, ['count'])

    // Pruning with 0 hours should delete everything
    const pruned = await aggregateStore.prune(0)
    expect(pruned).toBeGreaterThan(0)
  })
})
