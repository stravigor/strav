import ServiceProvider from '@strav/kernel/core/service_provider'
import type Application from '@strav/kernel/core/application'
import { PostgresSessionStore, RedisSessionStore } from '@strav/database'
import SessionManager from '../session/session_manager.ts'

export type SessionDriver = 'postgres' | 'redis'

export interface SessionProviderOptions {
  /** Session store driver. Default: `'postgres'`. */
  driver?: SessionDriver
  /** Whether to auto-create backing storage (SQL table, etc.). Default: `true` */
  ensureSchema?: boolean
}

/**
 * Wires the session store selected via `options.driver` ('postgres' | 'redis')
 * into SessionManager. The driver is chosen at provider construction because
 * provider dependencies are read before configuration is loaded.
 */
export default class SessionProvider extends ServiceProvider {
  readonly name = 'session'
  override readonly dependencies: string[]
  private readonly driver: SessionDriver

  constructor(private options?: SessionProviderOptions) {
    super()
    this.driver = options?.driver ?? 'postgres'
    this.dependencies = this.driver === 'redis' ? ['database', 'redis'] : ['database']
  }

  override register(app: Application): void {
    app.singleton(SessionManager)
  }

  override async boot(app: Application): Promise<void> {
    app.resolve(SessionManager)

    const store =
      this.driver === 'redis'
        ? app.resolve(RedisSessionStore)
        : app.resolve(PostgresSessionStore)

    SessionManager.useStore(store)

    if (this.options?.ensureSchema !== false) {
      await store.ensureSchema?.()
    }
  }
}
