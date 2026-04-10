import type Context from '../http/context.ts'
import { signJWT, verifyJWT, createMagicLinkToken, verifySignedToken } from '@strav/auth'
import type { JWTPayload, JWTSignOptions } from '@strav/auth'

/**
 * Helper functions to bridge @strav/auth primitives with HTTP contexts.
 * These utilities make it easy to use low-level auth tokens in HTTP scenarios.
 */

/**
 * Create a JWT token and return a Set-Cookie header value.
 *
 * @param payload - JWT payload
 * @param secret - Secret for signing
 * @param options - JWT and cookie options
 * @returns Object containing the JWT token and Set-Cookie header value
 */
export async function createJWTCookie(
  payload: JWTPayload,
  secret: string | Uint8Array,
  options: {
    cookieName?: string
    cookieOptions?: {
      domain?: string
      path?: string
      secure?: boolean
      sameSite?: 'strict' | 'lax' | 'none'
      maxAge?: number
    }
  } & JWTSignOptions = {}
): Promise<{ token: string; cookieHeader: string }> {
  const { cookieName = 'auth-token', cookieOptions = {}, ...jwtOptions } = options

  const token = await signJWT(payload, secret, jwtOptions)

  const cookieParts = [
    `${cookieName}=${token}`,
    'HttpOnly',
    'Secure',
    'SameSite=Strict'
  ]

  if (cookieOptions.domain) cookieParts.push(`Domain=${cookieOptions.domain}`)
  if (cookieOptions.path) cookieParts.push(`Path=${cookieOptions.path}`)
  if (cookieOptions.maxAge) cookieParts.push(`Max-Age=${cookieOptions.maxAge}`)
  if (cookieOptions.secure === false) cookieParts.splice(cookieParts.indexOf('Secure'), 1)
  if (cookieOptions.sameSite) {
    const index = cookieParts.findIndex(p => p.startsWith('SameSite'))
    cookieParts[index] = `SameSite=${cookieOptions.sameSite}`
  }

  return {
    token,
    cookieHeader: cookieParts.join('; ')
  }
}

/**
 * Extract and verify a JWT token from an HTTP-only cookie.
 *
 * @param ctx - The HTTP context
 * @param secret - Secret for verification
 * @param cookieName - Name of the cookie (defaults to 'auth-token')
 * @returns The verified JWT payload or null if invalid
 */
export async function verifyJWTCookie<T = JWTPayload>(
  ctx: Context,
  secret: string | Uint8Array,
  cookieName: string = 'auth-token'
): Promise<T | null> {
  const token = ctx.cookie(cookieName)
  if (!token) return null

  try {
    return await verifyJWT(token, secret) as T
  } catch {
    return null
  }
}

/**
 * Create a magic link URL with an embedded signed token.
 *
 * @param baseUrl - Base URL for the magic link
 * @param userId - User identifier
 * @param options - Magic link options
 * @returns Complete magic link URL
 */
export function createMagicLinkURL(
  baseUrl: string,
  userId: string | number,
  options: {
    email?: string
    redirect?: string
    expiresInMinutes?: number
    tokenParam?: string
  } = {}
): string {
  const { tokenParam = 'token', ...tokenOptions } = options

  const token = createMagicLinkToken(userId, tokenOptions)
  const url = new URL(baseUrl)
  url.searchParams.set(tokenParam, token)

  if (options.redirect) {
    url.searchParams.set('redirect', options.redirect)
  }

  return url.toString()
}

/**
 * Extract and verify a magic link token from HTTP context.
 *
 * @param ctx - The HTTP context
 * @param tokenParam - URL parameter containing the token (defaults to 'token')
 * @returns The verified token payload or null if invalid
 */
export function verifyMagicLinkFromContext(
  ctx: Context,
  tokenParam: string = 'token'
): { sub: string | number; email?: string; redirect?: string } | null {
  const token = ctx.query.get(tokenParam)
  if (!token) return null

  try {
    return verifySignedToken(token)
  } catch {
    return null
  }
}

/**
 * Extract Bearer token from Authorization header.
 *
 * @param ctx - The HTTP context
 * @returns The token string or null if not present
 */
export function extractBearerToken(ctx: Context): string | null {
  const header = ctx.header('authorization')
  if (!header?.startsWith('Bearer ')) return null

  return header.slice(7)
}

/**
 * Create an Authorization Bearer token header value.
 *
 * @param token - The token to set
 * @returns The formatted Authorization header value
 */
export function createBearerTokenHeader(token: string): string {
  return `Bearer ${token}`
}