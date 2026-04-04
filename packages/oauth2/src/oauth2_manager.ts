import { inject, Configuration, ConfigurationError } from '@strav/kernel'
import { Database } from '@strav/database'
import { Router, compose, rateLimit, auth, csrf } from '@strav/http'
import type { Handler, Middleware } from '@strav/http'
import ScopeRegistry from './scopes.ts'
import type { OAuth2Actions, OAuth2Config } from './types.ts'
import { authorizeHandler, approveHandler } from './handlers/authorize.ts'
import { tokenHandler } from './handlers/token.ts'
import { revokeHandler } from './handlers/revoke.ts'
import { introspectHandler } from './handlers/introspect.ts'
import { listClientsHandler, createClientHandler, deleteClientHandler } from './handlers/clients.ts'
import {
  createPersonalTokenHandler,
  listPersonalTokensHandler,
  revokePersonalTokenHandler,
} from './handlers/personal_tokens.ts'

// ---------------------------------------------------------------------------
// Default config
// ---------------------------------------------------------------------------

const DEFAULTS: OAuth2Config = {
  accessTokenLifetime: 60,
  refreshTokenLifetime: 43_200,
  authCodeLifetime: 10,
  personalAccessTokenLifetime: 525_600,
  prefix: '/oauth',
  routes: {
    aliases: {
      api: 'oauth2.api',
      admin: 'oauth2.admin'
    }
  },
  scopes: {},
  defaultScopes: [],
  personalAccessClient: null,
  rateLimit: {
    authorize: { max: 30, window: 60 },
    token: { max: 20, window: 60 },
  },
  pruneRevokedAfterDays: 7,
}

// ---------------------------------------------------------------------------
// Manager
// ---------------------------------------------------------------------------

function withMiddleware(mw: Middleware[], handler: Handler): Handler {
  return mw.length > 0 ? compose(mw, handler) : handler
}

@inject
export default class OAuth2Manager {
  private static _config: OAuth2Config
  private static _db: Database
  private static _actions: OAuth2Actions

  constructor(db: Database, config: Configuration) {
    const raw = config.get('oauth2', {}) as Partial<OAuth2Config>
    OAuth2Manager._db = db
    OAuth2Manager._config = { ...DEFAULTS, ...raw } as OAuth2Config

    // Register scopes from config
    if (OAuth2Manager._config.scopes) {
      ScopeRegistry.define(OAuth2Manager._config.scopes)
    }
  }

  // ── Accessors ────────────────────────────────────────────────────────

  static get config(): OAuth2Config {
    if (!OAuth2Manager._config) {
      throw new ConfigurationError(
        'OAuth2Manager not configured. Resolve it through the container first.'
      )
    }
    return OAuth2Manager._config
  }

  static get db(): Database {
    if (!OAuth2Manager._db) {
      throw new ConfigurationError(
        'OAuth2Manager not configured. Resolve it through the container first.'
      )
    }
    return OAuth2Manager._db
  }

  static get actions(): OAuth2Actions {
    if (!OAuth2Manager._actions) {
      throw new ConfigurationError('OAuth2 actions not set. Pass actions to OAuth2Provider.')
    }
    return OAuth2Manager._actions
  }

  /** Set the user-defined actions contract. */
  static useActions(actions: OAuth2Actions): void {
    OAuth2Manager._actions = actions
  }

  // ── Table management ─────────────────────────────────────────────────

  /** Create the required database tables if they don't exist. */
  static async ensureTables(): Promise<void> {
    const db = OAuth2Manager.db

    await db.sql`
      CREATE TABLE IF NOT EXISTS "_strav_oauth_clients" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "name" VARCHAR(255) NOT NULL,
        "secret" VARCHAR(255),
        "redirect_uris" JSONB NOT NULL DEFAULT '[]',
        "scopes" JSONB,
        "grant_types" JSONB NOT NULL DEFAULT '[]',
        "confidential" BOOLEAN NOT NULL DEFAULT true,
        "first_party" BOOLEAN NOT NULL DEFAULT false,
        "revoked" BOOLEAN NOT NULL DEFAULT false,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `

    await db.sql`
      CREATE TABLE IF NOT EXISTS "_strav_oauth_tokens" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "user_id" VARCHAR(255),
        "client_id" UUID NOT NULL REFERENCES "_strav_oauth_clients"("id") ON DELETE CASCADE,
        "name" VARCHAR(255),
        "scopes" JSONB NOT NULL DEFAULT '[]',
        "token" VARCHAR(255) NOT NULL UNIQUE,
        "refresh_token" VARCHAR(255) UNIQUE,
        "expires_at" TIMESTAMPTZ NOT NULL,
        "refresh_expires_at" TIMESTAMPTZ,
        "last_used_at" TIMESTAMPTZ,
        "revoked_at" TIMESTAMPTZ,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `

    await db.sql`
      CREATE TABLE IF NOT EXISTS "_strav_oauth_auth_codes" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "client_id" UUID NOT NULL REFERENCES "_strav_oauth_clients"("id") ON DELETE CASCADE,
        "user_id" VARCHAR(255) NOT NULL,
        "code" VARCHAR(255) NOT NULL UNIQUE,
        "redirect_uri" VARCHAR(2048) NOT NULL,
        "scopes" JSONB NOT NULL DEFAULT '[]',
        "code_challenge" VARCHAR(255),
        "code_challenge_method" VARCHAR(10),
        "expires_at" TIMESTAMPTZ NOT NULL,
        "used_at" TIMESTAMPTZ,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `

    // Indexes for common queries
    await db.sql`
      CREATE INDEX IF NOT EXISTS "idx_oauth_tokens_user_id"
      ON "_strav_oauth_tokens" ("user_id")
    `
    await db.sql`
      CREATE INDEX IF NOT EXISTS "idx_oauth_tokens_client_id"
      ON "_strav_oauth_tokens" ("client_id")
    `
    await db.sql`
      CREATE INDEX IF NOT EXISTS "idx_oauth_auth_codes_client_id"
      ON "_strav_oauth_auth_codes" ("client_id")
    `
  }

  // ── Route registration ───────────────────────────────────────────────

  private static rl(key: keyof OAuth2Config['rateLimit']): Middleware {
    const cfg = OAuth2Manager._config.rateLimit[key]
    return rateLimit({ max: cfg.max, window: cfg.window * 1000 })
  }

  /**
   * Register all OAuth2 routes on the given router.
   */
  static routes(router: Router): void {
    const config = OAuth2Manager._config
    const prefix = config.prefix
    const apiAlias = config.routes.aliases.api
    const adminAlias = config.routes.aliases.admin
    const subdomain = config.routes.subdomain

    router.group({ prefix, subdomain }, r => {
      // OAuth2 API routes
      r.group({}, apiRoutes).as(apiAlias)

      // Admin/management routes
      r.group({}, adminRoutes).as(adminAlias)
    })

    function apiRoutes(r: Router): void {
      // Authorization code flow
      r.get('/authorize', withMiddleware([auth(), OAuth2Manager.rl('authorize')], authorizeHandler)).as('authorize')
      r.post('/approve', withMiddleware([auth(), csrf()], approveHandler)).as('approve')

      // Token endpoint (all grant types)
      r.post('/token', withMiddleware([OAuth2Manager.rl('token')], tokenHandler)).as('token')

      // Revocation (RFC 7009)
      r.post('/revoke', revokeHandler).as('revoke')

      // Introspection (RFC 7662)
      r.post('/introspect', introspectHandler).as('introspect')
    }

    function adminRoutes(r: Router): void {
      // Client management
      r.get('/clients', withMiddleware([auth()], listClientsHandler)).as('clients')
      r.post('/clients', withMiddleware([auth()], createClientHandler)).as('create_client')
      r.delete('/clients/:id', withMiddleware([auth()], deleteClientHandler)).as('delete_client')

      // Personal access tokens
      r.post('/personal-tokens', withMiddleware([auth()], createPersonalTokenHandler)).as('create_personal_token')
      r.get('/personal-tokens', withMiddleware([auth()], listPersonalTokensHandler)).as('personal_tokens')
      r.delete('/personal-tokens/:id', withMiddleware([auth()], revokePersonalTokenHandler)).as('revoke_personal_token')
    }
  }

  /** Clear all state. For testing. */
  static reset(): void {
    OAuth2Manager._config = undefined as any
    OAuth2Manager._db = undefined as any
    OAuth2Manager._actions = undefined as any
    ScopeRegistry.reset()
  }
}
