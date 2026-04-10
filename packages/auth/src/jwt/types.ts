/**
 * JWT type definitions for the auth package.
 * Zero external dependencies.
 */

/**
 * Standard JWT payload claims.
 */
export interface JWTPayload {
  /** Issuer */
  iss?: string
  /** Subject */
  sub?: string
  /** Audience */
  aud?: string | string[]
  /** Expiration time (seconds since Unix epoch) */
  exp?: number
  /** Not before time (seconds since Unix epoch) */
  nbf?: number
  /** Issued at (seconds since Unix epoch) */
  iat?: number
  /** JWT ID */
  jti?: string
  /** Additional claims */
  [key: string]: unknown
}

/**
 * JWT header.
 */
export interface JWTHeader {
  /** Algorithm */
  alg: string
  /** Type (usually "JWT") */
  typ?: string
  /** Additional header params */
  [key: string]: unknown
}

export type JWTAlgorithm =
  | 'HS256' | 'HS384' | 'HS512'  // HMAC (supported)

export interface JWTSignOptions {
  /** Algorithm to use for signing (default: HS256) */
  algorithm?: JWTAlgorithm
  /** Expiration time (e.g., '15m', '1h', '7d') */
  expiresIn?: string | number
  /** Not before time */
  notBefore?: string | number
  /** Token issuer */
  issuer?: string
  /** Token audience */
  audience?: string | string[]
  /** Token subject */
  subject?: string
  /** JWT ID */
  jwtId?: string
}

export interface JWTVerifyOptions {
  /** Allowed algorithms */
  algorithms?: JWTAlgorithm[]
  /** Expected issuer */
  issuer?: string | string[]
  /** Expected audience */
  audience?: string | string[]
  /** Expected subject */
  subject?: string
  /** Required claims that must be present */
  requiredClaims?: string[]
}

export interface JWTKeyPair {
  /** Private key for signing */
  privateKey: Uint8Array | string
  /** Public key for verification */
  publicKey: Uint8Array | string
  /** Key algorithm */
  algorithm: JWTAlgorithm
}