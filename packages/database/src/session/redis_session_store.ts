import type { SessionStore, SessionRecord } from '@strav/kernel/session/session_store'
import Configuration from '@strav/kernel/config/configuration'
import { inject } from '@strav/kernel/core/inject'
import Redis from '../redis/redis.ts'

const KEY_PREFIX = 'strav:session:'

/**
 * Redis-backed {@link SessionStore}. Serializes records as JSON and leans on
 * Redis TTL for expiry — `gc()` is a no-op. The TTL is kept in sync with the
 * `session.lifetime` config (minutes).
 */
@inject
export default class RedisSessionStore implements SessionStore {
  private lifetimeSeconds: number

  constructor(private redis: Redis, config: Configuration) {
    const lifetimeMinutes: number = config.get('session.lifetime') ?? 120
    this.lifetimeSeconds = lifetimeMinutes * 60
  }

  async ensureSchema(): Promise<void> {
    // No-op: Redis creates keys on demand.
  }

  async find(id: string): Promise<SessionRecord | null> {
    const raw = await this.redis.client.get(key(id))
    if (!raw) return null
    return deserialize(raw)
  }

  async save(record: SessionRecord): Promise<void> {
    await this.redis.client.setex(key(record.id), this.lifetimeSeconds, serialize(record))
  }

  async destroy(id: string): Promise<void> {
    await this.redis.client.del(key(id))
  }

  async touch(id: string): Promise<void> {
    await this.redis.client.expire(key(id), this.lifetimeSeconds)
  }

  async gc(_cutoff: Date): Promise<number> {
    // Redis expires keys natively via TTL.
    return 0
  }
}

function key(id: string): string {
  return `${KEY_PREFIX}${id}`
}

function serialize(record: SessionRecord): string {
  return JSON.stringify({
    ...record,
    lastActivity: record.lastActivity.toISOString(),
    createdAt: record.createdAt.toISOString(),
  })
}

function deserialize(raw: string): SessionRecord {
  const parsed = JSON.parse(raw) as Omit<SessionRecord, 'lastActivity' | 'createdAt'> & {
    lastActivity: string
    createdAt: string
  }
  return {
    ...parsed,
    lastActivity: new Date(parsed.lastActivity),
    createdAt: new Date(parsed.createdAt),
  }
}
