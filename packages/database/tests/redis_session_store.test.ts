import { expect, test, describe, beforeAll, afterAll } from 'bun:test'
import { Container } from '@strav/kernel/core'
import Configuration from '@strav/kernel/config/configuration'
import type { SessionRecord } from '@strav/kernel/session/session_store'
import Redis from '../src/redis/redis'
import RedisSessionStore from '../src/session/redis_session_store'

const REDIS_AVAILABLE = Boolean(process.env.REDIS_HOST) || Boolean(process.env.REDIS_URL)

describe.if(REDIS_AVAILABLE)('RedisSessionStore', () => {
  let container: Container
  let redis: Redis
  let store: RedisSessionStore

  beforeAll(async () => {
    container = new Container()

    const config = new Configuration({})
    config.set('session.lifetime', 2) // 2 minutes = 120s TTL

    container.singleton(Configuration, () => config)
    container.singleton(Redis)
    container.singleton(RedisSessionStore)

    redis = container.resolve(Redis)
    await redis.connect()
    store = container.resolve(RedisSessionStore)
  })

  afterAll(async () => {
    // Cleanup any residual session keys from this run
    const keys = await redis.client.keys('strav:session:*')
    if (keys.length > 0) {
      await redis.client.del(...keys)
    }
    redis.close()
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

  test('save + find round-trips including Date fields', async () => {
    const record = makeRecord()
    await store.save(record)

    const found = await store.find(record.id)
    expect(found).not.toBeNull()
    expect(found!.id).toBe(record.id)
    expect(found!.csrfToken).toBe(record.csrfToken)
    expect(found!.data).toEqual(record.data)
    expect(found!.lastActivity).toBeInstanceOf(Date)
    expect(found!.createdAt).toBeInstanceOf(Date)
  })

  test('find returns null for unknown id', async () => {
    expect(await store.find(crypto.randomUUID())).toBeNull()
  })

  test('save applies TTL from session.lifetime', async () => {
    const record = makeRecord()
    await store.save(record)

    const ttl = await redis.client.ttl(`strav:session:${record.id}`)
    expect(ttl).toBeGreaterThan(0)
    expect(ttl).toBeLessThanOrEqual(120)
  })

  test('destroy removes the key', async () => {
    const record = makeRecord()
    await store.save(record)
    await store.destroy(record.id)
    expect(await store.find(record.id)).toBeNull()
  })

  test('touch refreshes TTL', async () => {
    const record = makeRecord()
    await store.save(record)

    // Shorten TTL manually then touch should bring it back up
    await redis.client.expire(`strav:session:${record.id}`, 10)
    await store.touch(record.id)

    const ttl = await redis.client.ttl(`strav:session:${record.id}`)
    expect(ttl).toBeGreaterThan(60)
  })

  test('gc is a no-op (native TTL)', async () => {
    const removed = await store.gc(new Date())
    expect(removed).toBe(0)
  })
})
