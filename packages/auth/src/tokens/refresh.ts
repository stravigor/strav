import { randomHex } from '@strav/kernel'

/**
 * Refresh token utilities for JWT rotation strategies.
 */

export interface RefreshTokenPair {
  /** The access token (short-lived) */
  accessToken: string
  /** The refresh token (long-lived) */
  refreshToken: string
}

/**
 * Generate a secure refresh token.
 *
 * @param length - Token length in bytes (default: 32)
 * @returns Hex-encoded refresh token
 */
export function generateRefreshToken(length: number = 32): string {
  return randomHex(length)
}

/**
 * Create a token rotation strategy helper.
 * This is a factory function that returns methods for your specific storage.
 *
 * @example
 * const rotation = createTokenRotation({
 *   async store(userId, token, expiresAt) {
 *     await db.refreshTokens.create({ userId, token, expiresAt })
 *   },
 *   async verify(token) {
 *     const record = await db.refreshTokens.findByToken(token)
 *     if (!record || record.expiresAt < new Date()) return null
 *     return record.userId
 *   },
 *   async revoke(token) {
 *     await db.refreshTokens.deleteByToken(token)
 *   }
 * })
 */
export function createTokenRotation(options: {
  store: (userId: string | number, token: string, expiresAt: Date) => Promise<void>
  verify: (token: string) => Promise<string | number | null>
  revoke: (token: string) => Promise<void>
  revokeAll?: (userId: string | number) => Promise<void>
}) {
  return {
    /**
     * Generate and store a new refresh token.
     */
    async generate(userId: string | number, ttlSeconds: number = 2592000): Promise<string> {
      const token = generateRefreshToken()
      const expiresAt = new Date(Date.now() + ttlSeconds * 1000)
      await options.store(userId, token, expiresAt)
      return token
    },

    /**
     * Verify a refresh token and return the user ID.
     */
    verify: options.verify,

    /**
     * Revoke a specific refresh token.
     */
    revoke: options.revoke,

    /**
     * Revoke all refresh tokens for a user.
     */
    revokeAll: options.revokeAll,
  }
}