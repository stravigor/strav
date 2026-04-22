import { inject } from '@strav/kernel/core/inject'
import { ConfigurationError } from '@strav/kernel/exceptions/errors'
import Configuration from '@strav/kernel/config/configuration'
import type { SessionStore } from '@strav/kernel/session/session_store'

export interface SessionConfig {
  driver: 'postgres' | 'redis'
  cookie: string
  lifetime: number
  httpOnly: boolean
  secure: boolean
  sameSite: 'strict' | 'lax' | 'none'
}

/**
 * Central session configuration hub.
 *
 * Resolved once via the DI container — holds the chosen {@link SessionStore}
 * and the parsed config shared by Session and the session middleware. The
 * store itself is plugged in by SessionProvider based on `session.driver`.
 *
 * @example
 * app.singleton(SessionManager)
 * app.resolve(SessionManager)
 * SessionManager.useStore(new PostgresSessionStore(db))
 */
@inject
export default class SessionManager {
  private static _store: SessionStore | null = null
  private static _config: SessionConfig

  constructor(config: Configuration) {
    SessionManager._config = {
      driver: 'postgres',
      cookie: 'strav_session',
      lifetime: 120,
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      ...(config.get('session', {}) as object),
    }
  }

  static get store(): SessionStore {
    if (!SessionManager._store) {
      throw new ConfigurationError(
        'SessionManager has no store configured. Call SessionManager.useStore() (SessionProvider does this on boot).'
      )
    }
    return SessionManager._store
  }

  static get config(): SessionConfig {
    return SessionManager._config
  }

  /** Plug in the session store. Called by SessionProvider based on config. */
  static useStore(store: SessionStore): void {
    SessionManager._store = store
  }

  /** Delete expired sessions. Call periodically for housekeeping. */
  static async gc(): Promise<number> {
    const lifetimeMs = SessionManager.config.lifetime * 60_000
    const cutoff = new Date(Date.now() - lifetimeMs)
    return SessionManager.store.gc(cutoff)
  }
}
