import { expect, test, describe, beforeAll, afterAll, beforeEach } from 'bun:test'
import { Container } from '@strav/kernel/core'
import Configuration from '@strav/kernel/config/configuration'
import type { SessionRecord } from '@strav/kernel/session/session_store'
import Database from '../src/database/database'
import PostgresSessionStore from '../src/session/postgres_session_store'

describe('PostgresSessionStore', () => {
  let container: Container
  let db: Database
  let store: PostgresSessionStore

  beforeAll(async () => {
    container = new Container()

    const config = new Configuration({})
    config.set('database.host', '127.0.0.1')
    config.set('database.port', 5432)
    config.set('database.username', 'liva')
    config.set('database.password', 'password1234')
    config.set('database.database', 'strav_testing')

    container.singleton(Configuration, () => config)
    container.singleton(Database)
    container.singleton(PostgresSessionStore)

    db = container.resolve(Database)
    store = container.resolve(PostgresSessionStore)

    await db.sql`DROP TABLE IF EXISTS "_strav_sessions"`
    await store.ensureSchema()
  })

  beforeEach(async () => {
    await db.sql`TRUNCATE TABLE "_strav_sessions"`
  })

  afterAll(async () => {
    await db.sql`DROP TABLE IF EXISTS "_strav_sessions"`
    await db.close()
  })

  function makeRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
    const now = new Date()
    return {
      id: crypto.randomUUID(),
      userId: null,
      csrfToken: 'csrf-token-value',
      data: { hello: 'world' },
      ipAddress: '127.0.0.1',
      userAgent: 'test-agent',
      lastActivity: now,
      createdAt: now,
      ...overrides,
    }
  }

  test('save + find round-trips a record', async () => {
    const record = makeRecord()
    await store.save(record)

    const found = await store.find(record.id)
    expect(found).not.toBeNull()
    expect(found!.id).toBe(record.id)
    expect(found!.csrfToken).toBe(record.csrfToken)
    expect(found!.data).toEqual(record.data)
    expect(found!.ipAddress).toBe(record.ipAddress)
    expect(found!.userAgent).toBe(record.userAgent)
  })

  test('find returns null for unknown id', async () => {
    const found = await store.find(crypto.randomUUID())
    expect(found).toBeNull()
  })

  test('save upserts existing rows', async () => {
    const record = makeRecord({ userId: null })
    await store.save(record)

    await store.save({ ...record, userId: 'user-123', data: { updated: true } })

    const found = await store.find(record.id)
    expect(found!.userId).toBe('user-123')
    expect(found!.data).toEqual({ updated: true })
  })

  test('destroy removes a record', async () => {
    const record = makeRecord()
    await store.save(record)
    await store.destroy(record.id)
    expect(await store.find(record.id)).toBeNull()
  })

  test('touch advances last_activity', async () => {
    const pastActivity = new Date(Date.now() - 60_000)
    const record = makeRecord({ lastActivity: pastActivity })
    await store.save(record)

    // Initial save uses NOW(); force the row's last_activity back to the past
    await db.sql`
      UPDATE "_strav_sessions" SET "last_activity" = ${pastActivity} WHERE "id" = ${record.id}
    `
    await store.touch(record.id)

    const found = await store.find(record.id)
    expect(found!.lastActivity.getTime()).toBeGreaterThan(pastActivity.getTime())
  })

  test('gc deletes sessions older than cutoff', async () => {
    const fresh = makeRecord()
    const stale = makeRecord()
    await store.save(fresh)
    await store.save(stale)

    const stalePast = new Date(Date.now() - 60 * 60_000)
    await db.sql`
      UPDATE "_strav_sessions" SET "last_activity" = ${stalePast} WHERE "id" = ${stale.id}
    `

    const cutoff = new Date(Date.now() - 30 * 60_000)
    const removed = await store.gc(cutoff)

    expect(removed).toBe(1)
    expect(await store.find(stale.id)).toBeNull()
    expect(await store.find(fresh.id)).not.toBeNull()
  })
})
