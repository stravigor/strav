export interface SocialUser {
  id: string
  name: string | null
  email: string | null
  /**
   * Whether the provider asserts the email has been verified by the user.
   *
   * Callers MUST check this before using `email` to match an existing
   * application user — linking by an unverified email is a known account-
   * takeover vector. See packages/social/CLAUDE.md ("Verified-email gate").
   */
  emailVerified: boolean
  avatar: string | null
  nickname: string | null
  token: string
  refreshToken: string | null
  expiresIn: number | null
  approvedScopes: string[]
  raw: Record<string, unknown>
}

export interface ProviderConfig {
  driver?: string
  clientId: string
  clientSecret: string
  redirectUrl: string
  scopes?: string[]
  /**
   * How to authenticate with the provider's token endpoint. Default
   * `'basic'` (HTTP Basic auth — RFC 6749 §2.3.1, MUST-support, keeps
   * `client_secret` out of body-logging surfaces). `'post'` falls back
   * to `client_secret` in the request body for providers that don't
   * accept Basic (e.g. Facebook). The `social` package picks the right
   * default per provider but you can override here if needed.
   */
  tokenEndpointAuthMethod?: 'basic' | 'post'
}

export interface SocialConfig {
  userKey: string
  providers: Record<string, ProviderConfig>
}

export interface TokenResponse {
  accessToken: string
  refreshToken: string | null
  expiresIn: number | null
  scope: string | null
}
