import { createSignedToken, verifySignedToken } from './signed.ts'

/**
 * Magic link token utilities for passwordless authentication.
 */

export interface MagicLinkPayload {
  sub: string | number
  typ: 'magic-link'
  email?: string
  redirect?: string
}

/**
 * Generate a magic link token for passwordless authentication.
 *
 * @param userId - The user identifier
 * @param options - Additional options
 * @returns Signed token string
 */
export function createMagicLinkToken(
  userId: string | number,
  options: {
    email?: string
    redirect?: string
    expiresInMinutes?: number
  } = {}
): string {
  const { email, redirect, expiresInMinutes = 15 } = options

  return createSignedToken(
    {
      sub: userId,
      typ: 'magic-link',
      email,
      redirect,
    },
    expiresInMinutes
  )
}

/**
 * Verify a magic link token.
 *
 * @param token - The token to verify
 * @returns The decoded payload
 * @throws If the token is invalid or expired
 */
export function verifyMagicLinkToken(token: string): MagicLinkPayload {
  const payload = verifySignedToken<MagicLinkPayload>(token)

  if (payload.typ !== 'magic-link') {
    throw new Error('Invalid token type')
  }

  return payload
}