import type { Context } from '@strav/http'

// ---------------------------------------------------------------------------
// Grant types
// ---------------------------------------------------------------------------

export type GrantType = 'authorization_code' | 'client_credentials' | 'refresh_token'

// ---------------------------------------------------------------------------
// Actions — the user-provided contract
// ---------------------------------------------------------------------------

export interface OAuth2Actions<TUser = unknown> {
  /** Find a user by primary key. Used to load the resource owner. */
  findById(id: string | number): Promise<TUser | null>

  /** Extract the user's display identifier (shown on consent screen). */
  identifierOf(user: TUser): string

  /**
   * Render the consent/authorization screen for third-party clients.
   * Return a Response (HTML page, view render, or redirect to your SPA).
   *
   * When not provided, the handler returns a JSON payload with the
   * authorization details so an SPA can render its own UI.
   */
  renderAuthorization?(
    ctx: Context,
    client: OAuthClientData,
    scopes: ScopeDescription[]
  ): Promise<Response>
}

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

export interface OAuthClientData {
  id: string
  name: string
  redirectUris: string[]
  scopes: string[] | null
  grantTypes: GrantType[]
  confidential: boolean
  firstParty: boolean
  revoked: boolean
  createdAt: Date
  updatedAt: Date
}

export interface OAuthTokenData {
  id: string
  userId: string | null
  clientId: string
  name: string | null
  scopes: string[]
  expiresAt: Date
  refreshExpiresAt: Date | null
  lastUsedAt: Date | null
  revokedAt: Date | null
  createdAt: Date
}

export interface OAuthAuthCodeData {
  id: string
  clientId: string
  userId: string
  redirectUri: string
  scopes: string[]
  codeChallenge: string | null
  codeChallengeMethod: string | null
  expiresAt: Date
  usedAt: Date | null
  createdAt: Date
}

export interface ScopeDescription {
  name: string
  description: string
}

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface CreateClientInput {
  name: string
  redirectUris: string[]
  confidential?: boolean
  firstParty?: boolean
  scopes?: string[] | null
  grantTypes?: GrantType[]
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface RateLimitConfig {
  max: number
  window: number // seconds
}

export interface OAuth2Config {
  accessTokenLifetime: number // minutes
  refreshTokenLifetime: number // minutes
  authCodeLifetime: number // minutes
  personalAccessTokenLifetime: number // minutes
  prefix: string
  routes: {
    /** Route group aliases for different OAuth2 endpoint types */
    aliases: {
      /** OAuth2 API endpoints (authorize, token, revoke, introspect) */
      api: string
      /** Admin/management endpoints (clients, personal tokens) */
      admin: string
    }
    /** Optional subdomain for OAuth2 routes */
    subdomain?: string
  }
  scopes: Record<string, string>
  defaultScopes: string[]
  personalAccessClient: string | null
  rateLimit: {
    authorize: RateLimitConfig
    token: RateLimitConfig
  }
  pruneRevokedAfterDays: number
  /**
   * Allow `code_challenge_method=plain` PKCE. RFC 7636 permits it but
   * S256 is strictly stronger — plain transmits the verifier in the
   * clear in a single HTTPS request, while S256 only sends a hash.
   * Default: `false` (S256-only). Enable only when interoperability
   * with a legacy client requires it; document the deployment
   * environment in your CHANGELOG when you do.
   */
  allowPlainPkce: boolean
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export interface OAuth2Event {
  ctx?: Context
  [key: string]: unknown
}

export const OAuth2Events = {
  TOKEN_ISSUED: 'oauth2:token-issued',
  TOKEN_REVOKED: 'oauth2:token-revoked',
  TOKEN_REFRESHED: 'oauth2:token-refreshed',
  CODE_ISSUED: 'oauth2:code-issued',
  CLIENT_CREATED: 'oauth2:client-created',
  CLIENT_REVOKED: 'oauth2:client-revoked',
  ACCESS_DENIED: 'oauth2:access-denied',
} as const
