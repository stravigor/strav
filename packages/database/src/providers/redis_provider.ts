import ServiceProvider from '@strav/kernel/core/service_provider'
import type Application from '@strav/kernel/core/application'
import Redis from '../redis/redis.ts'

export default class RedisProvider extends ServiceProvider {
  readonly name = 'redis'
  override readonly dependencies = ['config']

  private redis: Redis | null = null

  override register(app: Application): void {
    app.singleton(Redis)
  }

  override async boot(app: Application): Promise<void> {
    this.redis = app.resolve(Redis)
    await this.redis.connect()
  }

  override async shutdown(): Promise<void> {
    if (this.redis) {
      this.redis.close()
      this.redis = null
    }
  }
}
