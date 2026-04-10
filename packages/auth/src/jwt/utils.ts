/**
 * JWT utility functions - zero external dependencies.
 * Uses only Node.js/Bun built-in crypto APIs.
 */

import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Base64url encode a string or buffer.
 */
export function base64urlEncode(data: string | Buffer): string {
  const buffer = typeof data === 'string' ? Buffer.from(data) : data
  return buffer.toString('base64url')
}

/**
 * Base64url decode a string.
 */
export function base64urlDecode(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf8')
}

/**
 * Create HMAC signature for JWT.
 */
export function createHmacSignature(
  message: string,
  secret: string | Uint8Array,
  algorithm: 'sha256' | 'sha384' | 'sha512'
): string {
  const key = typeof secret === 'string' ? secret : Buffer.from(secret)
  return createHmac(algorithm, key)
    .update(message)
    .digest('base64url')
}

/**
 * Verify HMAC signature with timing-safe comparison.
 */
export function verifyHmacSignature(
  message: string,
  signature: string,
  secret: string | Uint8Array,
  algorithm: 'sha256' | 'sha384' | 'sha512'
): boolean {
  const expected = createHmacSignature(message, secret, algorithm)
  const expectedBuffer = Buffer.from(expected)
  const signatureBuffer = Buffer.from(signature)

  // Must be same length for timingSafeEqual
  if (expectedBuffer.length !== signatureBuffer.length) {
    return false
  }

  return timingSafeEqual(expectedBuffer, signatureBuffer)
}

/**
 * Parse expiration time strings like "15m", "1h", "30d" to seconds.
 */
export function parseExpirationTime(exp: string | number): number {
  if (typeof exp === 'number') {
    return exp
  }

  const match = exp.match(/^(\d+)([smhd])$/)
  if (!match) {
    throw new Error(`Invalid expiration time format: ${exp}`)
  }

  const value = parseInt(match[1]!, 10)
  const unit = match[2]!

  switch (unit) {
    case 's':
      return value
    case 'm':
      return value * 60
    case 'h':
      return value * 3600
    case 'd':
      return value * 86400
    default:
      throw new Error(`Invalid time unit: ${unit}`)
  }
}

/**
 * Get Unix timestamp in seconds.
 */
export function getUnixTimestamp(): number {
  return Math.floor(Date.now() / 1000)
}

/**
 * Map algorithm string to hash algorithm.
 */
export function getHashAlgorithm(alg: string): 'sha256' | 'sha384' | 'sha512' {
  switch (alg) {
    case 'HS256':
      return 'sha256'
    case 'HS384':
      return 'sha384'
    case 'HS512':
      return 'sha512'
    default:
      throw new Error(`Unsupported algorithm: ${alg}`)
  }
}