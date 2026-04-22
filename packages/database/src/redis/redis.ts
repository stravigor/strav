import { RedisClient } from 'bun'
import Configuration from '@strav/kernel/config/configuration'
import { inject } from '@strav/kernel/core/inject'
import { ConfigurationError } from '@strav/kernel/exceptions/errors'
import { env } from '@strav/kernel/helpers/env'

/**
 * Redis connection wrapper backed by {@link RedisClient Bun.RedisClient}.
 *
 * Reads connection settings from the `redis.*` configuration keys, falling back
 * to `REDIS_URL` or individual `REDIS_*` environment variables. Register as a
 * singleton in the DI container so one client is shared across the app.
 *
 * @example
 * container.singleton(Redis)
 * const redis = container.resolve(Redis)
 * await redis.client.set('key', 'value')
 */
@inject
export default class Redis {
  private static _connection: RedisClient | null = null
  private connection: RedisClient

  constructor(protected config: Configuration) {
    if (Redis._connection) {
      Redis._connection.close()
    }

    const url: string | null = config.get('redis.url') ?? env('REDIS_URL', null)
    this.connection = url ? new RedisClient(url) : new RedisClient(this.buildUrl(config))
    Redis._connection = this.connection
  }

  private buildUrl(config: Configuration): string {
    const host: string = config.get('redis.host') ?? env('REDIS_HOST', '127.0.0.1')
    const port: number = config.get('redis.port') ?? env.int('REDIS_PORT', 6379)
    const password: string = config.get('redis.password') ?? env('REDIS_PASSWORD', '')
    const db: number = config.get('redis.db') ?? env.int('REDIS_DB', 0)
    const auth = password ? `:${encodeURIComponent(password)}@` : ''
    return `redis://${auth}${host}:${port}/${db}`
  }

  /** The underlying Bun RedisClient. */
  get client(): RedisClient {
    return this.connection
  }

  /** The global Redis client, available after DI bootstrap. */
  static get raw(): RedisClient {
    if (!Redis._connection) {
      throw new ConfigurationError(
        'Redis not configured. Resolve Redis through the container first.'
      )
    }
    return Redis._connection
  }

  async connect(): Promise<void> {
    await this.connection.connect()
  }

  close(): void {
    this.connection.close()
    if (Redis._connection === this.connection) {
      Redis._connection = null
    }
  }
}
