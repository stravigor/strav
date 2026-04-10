import { inject } from '@strav/kernel/core/inject'
import { ConfigurationError } from '@strav/kernel/exceptions/errors'
import Configuration from '@strav/kernel/config/configuration'
import Database from '@strav/database/database/database'

// Re-export helpers that were originally defined here
export { extractUserId } from '@strav/database/helpers/identity'
export { randomHex } from '@strav/kernel/helpers/crypto'

// Re-export commonly used auth primitives for convenience
export {
  signJWT,
  verifyJWT,
  createAccessToken as createJWTAccessToken,
  createRefreshToken as createJWTRefreshToken,
  verifyAccessToken,
  verifyRefreshToken
} from '@strav/auth/jwt'

export {
  createSignedToken,
  verifySignedToken,
  createMagicLinkToken,
  verifyMagicLinkToken
} from '@strav/auth/tokens'

export interface TokenConfig {
  expiration: number | null
}

export interface AuthConfig {
  default: string
  token: TokenConfig
}

type UserResolver = (id: string | number) => Promise<unknown>

/**
 * Central auth configuration hub.
 *
 * Resolved once via the DI container — stores the database reference,
 * parsed config, and user resolver for AccessToken and auth middleware.
 *
 * @example
 * app.singleton(Auth)
 * app.resolve(Auth)
 * Auth.useResolver((id) => User.find(id))
 * await Auth.ensureTables()
 */
@inject
export default class Auth {
  private static _db: Database
  private static _config: AuthConfig
  private static _resolver: UserResolver

  constructor(db: Database, config: Configuration) {
    Auth._db = db
    Auth._config = {
      default: config.get('auth.default', 'session') as string,
      token: {
        expiration: null,
        ...(config.get('auth.token', {}) as object),
      },
    }
  }

  /** Register the function used to load a user by ID. */
  static useResolver(resolver: UserResolver): void {
    Auth._resolver = resolver
  }

  static get db(): Database {
    if (!Auth._db)
      throw new ConfigurationError('Auth not configured. Resolve Auth through the container first.')
    return Auth._db
  }

  static get config(): AuthConfig {
    return Auth._config
  }

  /** Load a user by ID using the registered resolver. */
  static async resolveUser(id: string | number): Promise<unknown> {
    if (!Auth._resolver) {
      throw new ConfigurationError('Auth resolver not configured. Call Auth.useResolver() first.')
    }
    return Auth._resolver(id)
  }

  /** Create the internal access_tokens table if it doesn't exist. */
  static async ensureTables(): Promise<void> {
    await Auth.db.sql`
      CREATE TABLE IF NOT EXISTS "_strav_access_tokens" (
        "id" SERIAL PRIMARY KEY,
        "user_id" VARCHAR(255) NOT NULL,
        "name" VARCHAR(255) NOT NULL,
        "token" VARCHAR(64) NOT NULL UNIQUE,
        "last_used_at" TIMESTAMPTZ,
        "expires_at" TIMESTAMPTZ,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `
  }
}
