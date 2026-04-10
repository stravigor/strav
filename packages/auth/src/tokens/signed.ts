import { encrypt } from '@strav/kernel'

/**
 * Signed, opaque token utilities using Strav's encryption.
 * These tokens are encrypted and tamper-proof.
 */

export interface SignedTokenPayload {
  /** User identifier. */
  sub: string | number
  /** Token purpose. */
  typ: string
  /** Issued at (unix ms). */
  iat: number
  /** Expiration (minutes from iat). */
  exp: number
  /** Extra data. */
  [key: string]: unknown
}

/**
 * Create a signed, encrypted token using `encrypt.seal()`.
 * Tamper-proof and opaque — the user cannot read or modify the payload.
 *
 * @param data  - The payload to sign.
 * @param expiresInMinutes - Token lifetime in minutes.
 */
export function createSignedToken(
  data: { sub: string | number; typ: string; [key: string]: unknown },
  expiresInMinutes: number
): string {
  const payload: SignedTokenPayload = {
    ...data,
    iat: Date.now(),
    exp: expiresInMinutes,
  }
  return encrypt.seal(payload)
}

/**
 * Verify and decode a signed token. Throws if expired or tampered.
 *
 * @returns The original payload.
 * @throws  If the token is invalid, expired, or tampered.
 */
export function verifySignedToken<T = SignedTokenPayload>(token: string): T {
  const payload = encrypt.unseal<SignedTokenPayload>(token)

  if (!payload || typeof payload !== 'object' || !payload.iat) {
    throw new Error('Invalid token payload.')
  }

  if (payload.exp) {
    const expiresAt = payload.iat + payload.exp * 60_000
    if (Date.now() > expiresAt) {
      throw new Error('Token has expired.')
    }
  }

  return payload as unknown as T
}