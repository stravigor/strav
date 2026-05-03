import OAuth2Manager from './oauth2_manager.ts'
import { randomHex } from '@strav/kernel'
import type { OAuthAuthCodeData } from './types.ts'

function hashCode(plain: string): string {
  return new Bun.CryptoHasher('sha256').update(plain).digest('hex')
}

/**
 * Static helper for managing OAuth2 authorization codes.
 *
 * Codes are SHA-256 hashed before storage and are single-use.
 *
 * @example
 * const { code, codeData } = await AuthCode.create({ ... })
 * const record = await AuthCode.consume(plainCode, clientId, redirectUri, codeVerifier)
 */
export default class AuthCode {
  /**
   * Create a new authorization code.
   * Returns the plain-text code (sent to client via redirect) and the DB record.
   */
  static async create(params: {
    clientId: string
    userId: string
    redirectUri: string
    scopes: string[]
    codeChallenge?: string | null
    codeChallengeMethod?: string | null
  }): Promise<{ code: string; codeData: OAuthAuthCodeData }> {
    const config = OAuth2Manager.config
    const plainCode = randomHex(40)
    const hashedCode = hashCode(plainCode)
    const expiresAt = new Date(Date.now() + config.authCodeLifetime * 60_000)

    const rows = await OAuth2Manager.db.sql`
      INSERT INTO "_strav_oauth_auth_codes" (
        "client_id", "user_id", "code", "redirect_uri", "scopes",
        "code_challenge", "code_challenge_method", "expires_at"
      )
      VALUES (
        ${params.clientId},
        ${params.userId},
        ${hashedCode},
        ${params.redirectUri},
        ${JSON.stringify(params.scopes)},
        ${params.codeChallenge ?? null},
        ${params.codeChallengeMethod ?? null},
        ${expiresAt}
      )
      RETURNING *
    `

    return {
      code: plainCode,
      codeData: AuthCode.hydrate(rows[0] as Record<string, unknown>),
    }
  }

  /**
   * Consume an authorization code. Validates and marks it as used.
   *
   * Checks:
   * - Code exists, belongs to the client, and has not been used before
   *   (atomic — see below)
   * - Code is not expired
   * - Redirect URI matches
   * - PKCE code_verifier matches (if code_challenge was set)
   *
   * The "mark used" step is fused into the lookup as a single
   * `UPDATE … SET used_at = NOW() WHERE … AND used_at IS NULL RETURNING *`
   * so two concurrent requests with the same code can never both
   * observe `used_at IS NULL` — exactly one wins, the other gets zero
   * rows back. Post-checks (expired / redirect_uri / PKCE) run AFTER
   * the row has been claimed; if any fail we still return null and the
   * code stays burned, which is the right semantic — a failed redemption
   * attempt prevents replay even if it didn't issue a token.
   *
   * Returns the code data if valid, null otherwise.
   */
  static async consume(
    plainCode: string,
    clientId: string,
    redirectUri: string,
    codeVerifier?: string | null
  ): Promise<OAuthAuthCodeData | null> {
    const hash = hashCode(plainCode)

    const rows = await OAuth2Manager.db.sql`
      UPDATE "_strav_oauth_auth_codes"
      SET "used_at" = NOW()
      WHERE "code" = ${hash}
        AND "client_id" = ${clientId}
        AND "used_at" IS NULL
      RETURNING *
    `
    if (rows.length === 0) return null

    const record = AuthCode.hydrate(rows[0] as Record<string, unknown>)

    // Expired
    if (record.expiresAt.getTime() < Date.now()) return null

    // Redirect URI mismatch
    if (record.redirectUri !== redirectUri) return null

    // PKCE verification
    if (record.codeChallenge) {
      if (!codeVerifier) return null

      if (record.codeChallengeMethod === 'S256') {
        const verifierHash = new Bun.CryptoHasher('sha256').update(codeVerifier).digest('base64url')
        if (verifierHash !== record.codeChallenge) return null
      } else {
        // plain method (only stored when allowPlainPkce was set at authorize time)
        if (codeVerifier !== record.codeChallenge) return null
      }
    }

    return record
  }

  /** Prune expired and used auth codes. Returns the number of deleted rows. */
  static async prune(): Promise<number> {
    const result = await OAuth2Manager.db.sql`
      DELETE FROM "_strav_oauth_auth_codes"
      WHERE "expires_at" < NOW() OR "used_at" IS NOT NULL
    `
    return result.count ?? 0
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  static hydrate(row: Record<string, unknown>): OAuthAuthCodeData {
    return {
      id: String(row.id),
      clientId: String(row.client_id),
      userId: row.user_id as string,
      redirectUri: row.redirect_uri as string,
      scopes: parseJsonb(row.scopes) as string[],
      codeChallenge: (row.code_challenge as string) ?? null,
      codeChallengeMethod: (row.code_challenge_method as string) ?? null,
      expiresAt: row.expires_at as Date,
      usedAt: (row.used_at as Date) ?? null,
      createdAt: row.created_at as Date,
    }
  }
}

function parseJsonb(value: unknown): unknown {
  if (value === null || value === undefined) return []
  if (typeof value === 'string') return JSON.parse(value)
  return value
}
