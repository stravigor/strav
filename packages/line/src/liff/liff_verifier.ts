import { ConfigurationError, ExternalServiceError } from '@strav/kernel'

export interface LiffVerifierConfig {
  /**
   * LIFF channel ID. Used as the OAuth `client_id` in the verify call and
   * checked against the `aud` claim returned by LINE.
   */
  channelId: string
  /** Override the LINE OAuth base URL. Default: 'https://api.line.me' */
  baseUrl?: string
}

/**
 * Claims returned by LINE's ID-token verify endpoint.
 *
 * `sub` is the LINE user ID (`U…` for normal users). `aud` matches the
 * channelId. `name` / `picture` / `email` are only populated when the
 * corresponding scope was granted in the LIFF channel settings.
 *
 * @see https://developers.line.biz/en/reference/line-login/#verify-id-token
 */
export interface LiffIdTokenClaims {
  iss: string
  sub: string
  aud: string
  exp: number
  iat: number
  nonce?: string
  amr?: string[]
  name?: string
  picture?: string
  email?: string
}

/**
 * Verifies LIFF ID tokens by calling LINE's hosted verify endpoint.
 *
 * The endpoint authenticates the JWT signature, validates expiry, and
 * checks audience for us — we only have to forward the token and the
 * channel ID. Returns the parsed claims on success.
 *
 * Use this from a LIFF webview handler:
 *
 *   const idToken = await liff.getIDToken()        // client side
 *   await fetch('/liff/login', { method: 'POST', body: JSON.stringify({ idToken }) })
 *
 *   // server side
 *   const claims = await LineManager.liff().verify(idToken)
 *   const userId = claims.sub                      // LINE user ID
 *
 * Alternative: verify locally with JWKS for fewer network hops. Not
 * implemented here because the hosted endpoint is the LINE-recommended
 * default and matches existing strav patterns (no key caching to manage).
 */
export class LiffVerifier {
  private readonly channelId: string
  private readonly baseUrl: string

  constructor(config: LiffVerifierConfig) {
    if (!config.channelId) {
      throw new ConfigurationError('LiffVerifier requires channelId')
    }
    this.channelId = config.channelId
    this.baseUrl = config.baseUrl ?? 'https://api.line.me'
  }

  /**
   * Verify an ID token from `liff.getIDToken()` and return its claims.
   * Throws ExternalServiceError if the token is invalid or LINE rejects it.
   */
  async verify(idToken: string): Promise<LiffIdTokenClaims> {
    if (!idToken) {
      throw new ExternalServiceError('LINE', 400, 'idToken is required')
    }
    const params = new URLSearchParams({
      id_token: idToken,
      client_id: this.channelId,
    })
    const response = await fetch(`${this.baseUrl}/oauth2/v2.1/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    })
    const text = await response.text()
    const raw: unknown = text ? safeJson(text) : undefined
    if (!response.ok) {
      throw new ExternalServiceError(
        'LINE',
        response.status,
        formatError(raw) ?? 'ID token verification failed'
      )
    }
    return raw as LiffIdTokenClaims
  }

  /**
   * Verify an access token from `liff.getAccessToken()`. Returns the token
   * info (expiry, scope, client_id). Useful when you want to call the LINE
   * profile API on the user's behalf with the same access token.
   *
   * @see https://developers.line.biz/en/reference/line-login/#verify-access-token
   */
  async verifyAccessToken(accessToken: string): Promise<{
    scope: string
    client_id: string
    expires_in: number
  }> {
    if (!accessToken) {
      throw new ExternalServiceError('LINE', 400, 'accessToken is required')
    }
    const url = `${this.baseUrl}/oauth2/v2.1/verify?access_token=${encodeURIComponent(accessToken)}`
    const response = await fetch(url)
    const text = await response.text()
    const raw: unknown = text ? safeJson(text) : undefined
    if (!response.ok) {
      throw new ExternalServiceError(
        'LINE',
        response.status,
        formatError(raw) ?? 'access token verification failed'
      )
    }
    const info = raw as { scope: string; client_id: string; expires_in: number }
    if (info.client_id !== this.channelId) {
      throw new ExternalServiceError(
        'LINE',
        401,
        `access token issued for client_id ${info.client_id}, expected ${this.channelId}`
      )
    }
    return info
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function formatError(raw: unknown): string | undefined {
  if (!raw) return undefined
  if (typeof raw === 'string') return raw
  if (typeof raw === 'object' && raw !== null) {
    const r = raw as Record<string, unknown>
    const description = typeof r.error_description === 'string' ? r.error_description : undefined
    const error = typeof r.error === 'string' ? r.error : undefined
    return description ?? error
  }
  return undefined
}
