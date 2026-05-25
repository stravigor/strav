import { ExternalServiceError, scrubProviderError } from '@strav/kernel'

/**
 * Shared OAuth 2.0 client building blocks used by the per-platform OAuth
 * helpers (Meta, Google Business). WordPress uses Application Passwords
 * (HTTP Basic) and doesn't go through these.
 *
 * Per-platform helpers (`MetaOAuth`, `GoogleBusinessOAuth`) layer the
 * platform-specific scope defaults, account-selection steps (pick a
 * Facebook Page, pick a GBP location), and credential persistence on top
 * of these primitives.
 */

export interface OAuthClientConfig {
  clientId: string
  clientSecret: string
  redirectUrl: string
}

export interface TokenResponse {
  accessToken: string
  refreshToken: string | null
  expiresIn: number | null
  scope: string | null
  /** Anything else the provider returned (id_token, ig_user_id, etc.). */
  raw: Record<string, unknown>
}

/**
 * Build the authorization URL the user is redirected to.
 *
 * `state` should be a freshly generated random value persisted on the
 * server (typically in the session) so the callback can verify it — same
 * CSRF mitigation pattern @strav/social uses.
 */
export function buildAuthUrl(opts: {
  authUrl: string
  config: OAuthClientConfig
  scopes: string[]
  state: string
  /** Provider-specific extra query parameters (`access_type=offline`, etc.). */
  extra?: Record<string, string>
}): string {
  const params = new URLSearchParams({
    client_id: opts.config.clientId,
    redirect_uri: opts.config.redirectUrl,
    response_type: 'code',
    scope: opts.scopes.join(' '),
    state: opts.state,
    ...(opts.extra ?? {}),
  })
  return `${opts.authUrl}?${params.toString()}`
}

/**
 * Exchange an authorization code for an access token.
 *
 * `secretIn` toggles the conventional `client_secret_basic` (RFC 6749
 * §2.3.1, default) vs `client_secret_post` — providers like Meta only
 * accept the latter. Mirrors @strav/social's tokenEndpointAuthMethod.
 */
export async function exchangeCode(opts: {
  tokenUrl: string
  config: OAuthClientConfig
  code: string
  secretIn?: 'basic' | 'post'
  extra?: Record<string, string>
}): Promise<TokenResponse> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  }
  const body: Record<string, string> = {
    grant_type: 'authorization_code',
    client_id: opts.config.clientId,
    code: opts.code,
    redirect_uri: opts.config.redirectUrl,
    ...(opts.extra ?? {}),
  }
  if ((opts.secretIn ?? 'basic') === 'basic') {
    const creds = `${opts.config.clientId}:${opts.config.clientSecret}`
    headers.Authorization = `Basic ${Buffer.from(creds, 'utf8').toString('base64')}`
  } else {
    body.client_secret = opts.config.clientSecret
  }
  return performTokenRequest(opts.tokenUrl, headers, body)
}

/**
 * Exchange a refresh token for a fresh access token. Used by publishers'
 * `refresh()` hook (Meta, Google Business).
 */
export async function refreshAccessToken(opts: {
  tokenUrl: string
  config: OAuthClientConfig
  refreshToken: string
  secretIn?: 'basic' | 'post'
  extra?: Record<string, string>
}): Promise<TokenResponse> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
    Accept: 'application/json',
  }
  const body: Record<string, string> = {
    grant_type: 'refresh_token',
    client_id: opts.config.clientId,
    refresh_token: opts.refreshToken,
    ...(opts.extra ?? {}),
  }
  if ((opts.secretIn ?? 'basic') === 'basic') {
    const creds = `${opts.config.clientId}:${opts.config.clientSecret}`
    headers.Authorization = `Basic ${Buffer.from(creds, 'utf8').toString('base64')}`
  } else {
    body.client_secret = opts.config.clientSecret
  }
  return performTokenRequest(opts.tokenUrl, headers, body)
}

async function performTokenRequest(
  tokenUrl: string,
  headers: Record<string, string>,
  body: Record<string, string>
): Promise<TokenResponse> {
  const response = await fetch(tokenUrl, {
    method: 'POST',
    headers,
    body: new URLSearchParams(body),
  })
  if (!response.ok) {
    const text = await response.text()
    throw new ExternalServiceError('OAuth', response.status, scrubProviderError(text))
  }
  const data = (await response.json()) as Record<string, unknown>
  return {
    accessToken: data.access_token as string,
    refreshToken: (data.refresh_token as string) ?? null,
    expiresIn: typeof data.expires_in === 'number' ? data.expires_in : null,
    scope: typeof data.scope === 'string' ? data.scope : null,
    raw: data,
  }
}
