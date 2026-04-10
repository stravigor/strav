import type { JWTPayload, JWTHeader, JWTVerifyOptions } from './types.ts'
import {
  base64urlDecode,
  verifyHmacSignature,
  getUnixTimestamp,
  getHashAlgorithm,
} from './utils.ts'

/**
 * Verify a JWT and return its payload.
 * Zero external dependencies.
 *
 * @param token - The JWT string to verify
 * @param secret - The secret key for HMAC
 * @param options - Verification options
 * @returns The verified payload
 * @throws If the token is invalid, expired, or doesn't meet requirements
 */
export async function verifyJWT<T extends JWTPayload = JWTPayload>(
  token: string,
  secret: Uint8Array | string,
  options: JWTVerifyOptions = {}
): Promise<T> {
  const {
    issuer,
    audience,
    subject,
    algorithms = ['HS256', 'HS384', 'HS512'],
    requiredClaims = [],
  } = options

  // Split token into parts
  const parts = token.split('.')
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format')
  }

  const [encodedHeader, encodedPayload, signature] = parts

  // Decode header and payload
  let header: JWTHeader
  let payload: JWTPayload

  try {
    header = JSON.parse(base64urlDecode(encodedHeader!))
    payload = JSON.parse(base64urlDecode(encodedPayload!))
  } catch (error) {
    throw new Error('Invalid JWT encoding')
  }

  // Verify algorithm is allowed
  if (!algorithms.includes(header.alg as any)) {
    throw new Error(`Algorithm ${header.alg} is not allowed`)
  }

  // Verify signature
  const message = `${encodedHeader}.${encodedPayload}`
  const hashAlg = getHashAlgorithm(header.alg)
  const isValidSignature = verifyHmacSignature(message, signature!, secret, hashAlg)

  if (!isValidSignature) {
    throw new Error('Invalid JWT signature')
  }

  // Verify temporal claims
  const now = getUnixTimestamp()

  if (payload.exp !== undefined && now >= payload.exp) {
    throw new Error('JWT has expired')
  }

  if (payload.nbf !== undefined && now < payload.nbf) {
    throw new Error('JWT is not yet valid')
  }

  // Verify issuer
  if (issuer !== undefined) {
    const expectedIssuers = Array.isArray(issuer) ? issuer : [issuer]
    if (!expectedIssuers.includes(payload.iss!)) {
      throw new Error('Invalid JWT issuer')
    }
  }

  // Verify audience
  if (audience !== undefined) {
    const expectedAudiences = Array.isArray(audience) ? audience : [audience]
    const tokenAudiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud]

    const hasValidAudience = expectedAudiences.some(exp =>
      tokenAudiences.includes(exp)
    )

    if (!hasValidAudience) {
      throw new Error('Invalid JWT audience')
    }
  }

  // Verify subject
  if (subject !== undefined && payload.sub !== subject) {
    throw new Error('Invalid JWT subject')
  }

  // Check required claims
  for (const claim of requiredClaims) {
    if (!(claim in payload)) {
      throw new Error(`Missing required claim: ${claim}`)
    }
  }

  return payload as T
}

/**
 * Verify an access token and return the user ID.
 *
 * @param token - The JWT access token
 * @param secret - The secret key
 * @param options - Additional verification options
 * @returns The user ID from the token
 */
export async function verifyAccessToken(
  token: string,
  secret: Uint8Array | string,
  options: JWTVerifyOptions = {}
): Promise<string> {
  const payload = await verifyJWT(token, secret, {
    ...options,
    requiredClaims: ['sub', 'type', ...(options.requiredClaims || [])],
  })

  if (payload.type !== 'access') {
    throw new Error('Invalid token type')
  }

  return payload.sub!
}

/**
 * Verify a refresh token.
 *
 * @param token - The JWT refresh token
 * @param secret - The secret key
 * @param options - Additional verification options
 * @returns The user ID from the token
 */
export async function verifyRefreshToken(
  token: string,
  secret: Uint8Array | string,
  options: JWTVerifyOptions = {}
): Promise<string> {
  const payload = await verifyJWT(token, secret, {
    ...options,
    requiredClaims: ['sub', 'type', ...(options.requiredClaims || [])],
  })

  if (payload.type !== 'refresh') {
    throw new Error('Invalid token type')
  }

  return payload.sub!
}

/**
 * Decode a JWT without verifying it.
 * WARNING: Only use this when you need to read claims before verification.
 * Always verify tokens for authentication!
 *
 * @param token - The JWT string
 * @returns The decoded payload (unverified)
 */
export function decodeJWT(token: string): JWTPayload {
  const parts = token.split('.')
  if (parts.length !== 3) {
    throw new Error('Invalid JWT format')
  }

  try {
    const payload = JSON.parse(base64urlDecode(parts[1]!))
    return payload
  } catch (error) {
    throw new Error('Invalid JWT encoding')
  }
}