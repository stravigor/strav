import type { JWTPayload, JWTHeader, JWTSignOptions, JWTAlgorithm } from './types.ts'
import {
  base64urlEncode,
  createHmacSignature,
  parseExpirationTime,
  getUnixTimestamp,
  getHashAlgorithm,
} from './utils.ts'

/**
 * Sign a JWT using built-in crypto with sensible defaults.
 * Zero external dependencies.
 *
 * @param payload - The JWT payload
 * @param secret - The secret key for HMAC
 * @param options - Additional JWT options
 * @returns Signed JWT string
 */
export async function signJWT(
  payload: JWTPayload,
  secret: Uint8Array | string,
  options: JWTSignOptions = {}
): Promise<string> {
  const {
    algorithm = 'HS256',
    expiresIn,
    notBefore,
    issuer,
    audience,
    subject,
    jwtId,
  } = options

  // Build the payload with standard claims
  const now = getUnixTimestamp()
  const jwtPayload: JWTPayload = {
    ...payload,
    iat: now,
  }

  // Set standard claims if provided
  if (expiresIn) {
    const expSeconds = parseExpirationTime(expiresIn)
    jwtPayload.exp = now + expSeconds
  }
  if (notBefore) {
    const nbfSeconds = typeof notBefore === 'number'
      ? notBefore
      : parseExpirationTime(notBefore)
    jwtPayload.nbf = now + nbfSeconds
  }
  if (issuer) jwtPayload.iss = issuer
  if (audience) jwtPayload.aud = audience
  if (subject) jwtPayload.sub = subject
  if (jwtId) jwtPayload.jti = jwtId

  // Build the header
  const header: JWTHeader = {
    alg: algorithm,
    typ: 'JWT',
  }

  // Encode header and payload
  const encodedHeader = base64urlEncode(JSON.stringify(header))
  const encodedPayload = base64urlEncode(JSON.stringify(jwtPayload))

  // Create the message to sign
  const message = `${encodedHeader}.${encodedPayload}`

  // Sign the message
  const hashAlg = getHashAlgorithm(algorithm)
  const signature = createHmacSignature(message, secret, hashAlg)

  // Return the complete JWT
  return `${message}.${signature}`
}

/**
 * Create an access token with user claims.
 *
 * @param userId - User identifier
 * @param secret - Secret key
 * @param claims - Additional claims to include
 * @param options - JWT options
 */
export async function createAccessToken(
  userId: string | number,
  secret: Uint8Array | string,
  claims: Record<string, unknown> = {},
  options: JWTSignOptions = {}
): Promise<string> {
  return signJWT(
    {
      sub: String(userId),
      type: 'access',
      ...claims,
    },
    secret,
    {
      expiresIn: '15m',
      ...options,
    }
  )
}

/**
 * Create a longer-lived refresh token.
 *
 * @param userId - User identifier
 * @param secret - Secret key
 * @param options - JWT options
 */
export async function createRefreshToken(
  userId: string | number,
  secret: Uint8Array | string,
  options: JWTSignOptions = {}
): Promise<string> {
  return signJWT(
    {
      sub: String(userId),
      type: 'refresh',
    },
    secret,
    {
      expiresIn: '30d',
      ...options,
    }
  )
}