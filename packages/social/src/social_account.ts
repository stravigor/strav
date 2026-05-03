import { EncryptionManager, Emitter } from '@strav/kernel'
import { extractUserId } from '@strav/database'
import SocialManager from './social_manager.ts'
import type { SocialUser } from './types.ts'

const ENC_PREFIX = 'enc:v1:'

/**
 * Encrypt an OAuth token before persisting it. The `enc:v1:` prefix is the
 * sentinel that lets reads distinguish encrypted values from legacy
 * plaintext rows that predate the encryption-at-rest migration.
 */
function encryptToken(plain: string): string {
  return ENC_PREFIX + EncryptionManager.encrypt(plain)
}

/**
 * Decrypt a stored token. Values without the `enc:v1:` prefix are assumed
 * to be legacy plaintext (predate encryption-at-rest); they are returned
 * as-is and re-encrypted on next write.
 */
function decryptToken(stored: string): string {
  if (!stored.startsWith(ENC_PREFIX)) return stored
  return EncryptionManager.decrypt(stored.slice(ENC_PREFIX.length))
}

/** The DB record for a social account link. */
export interface SocialAccountData {
  id: number
  userId: string | number
  provider: string
  providerId: string
  token: string
  refreshToken: string | null
  expiresAt: Date | null
  createdAt: Date
  updatedAt: Date
}

/**
 * Static helper for managing social account records.
 *
 * Follows the same pattern as AccessToken: all methods are static,
 * database access goes through the parent manager (SocialManager.db).
 *
 * @example
 * const account = await SocialAccount.findByProvider('github', '12345')
 * const accounts = await SocialAccount.findByUser(user)
 * const created = await SocialAccount.create({ user, provider: 'google', ... })
 */
export default class SocialAccount {
  private static get sql() {
    return SocialManager.db.sql
  }

  private static get fk() {
    return SocialManager.userFkColumn
  }

  /**
   * Find a social account by provider name and provider-specific user ID.
   * This is the primary lookup used during OAuth callback.
   */
  static async findByProvider(
    provider: string,
    providerId: string
  ): Promise<SocialAccountData | null> {
    const rows = await SocialAccount.sql`
      SELECT * FROM "social_account"
      WHERE "provider" = ${provider}
        AND "provider_id" = ${providerId}
      LIMIT 1
    `
    return rows.length > 0 ? SocialAccount.hydrate(rows[0] as Record<string, unknown>) : null
  }

  /**
   * Find all social accounts linked to a user.
   */
  static async findByUser(user: unknown): Promise<SocialAccountData[]> {
    const userId = extractUserId(user)
    const fk = SocialAccount.fk
    const rows = await SocialAccount.sql.unsafe(
      `SELECT * FROM "social_account" WHERE "${fk}" = $1 ORDER BY "created_at" ASC`,
      [userId]
    )
    return rows.map((r: any) => SocialAccount.hydrate(r))
  }

  /**
   * Create a new social account link. Emits `social_account:linked`
   * after a successful insert so apps can wire `@strav/audit` (or any
   * other observability sink) without forcing a hard dependency.
   */
  static async create(data: {
    user: unknown
    provider: string
    providerId: string
    token: string
    refreshToken?: string | null
    expiresAt?: Date | null
  }): Promise<SocialAccountData> {
    const userId = extractUserId(data.user)
    const fk = SocialAccount.fk
    const rows = await SocialAccount.sql.unsafe(
      `INSERT INTO "social_account" ("${fk}", "provider", "provider_id", "token", "refresh_token", "expires_at")
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        userId,
        data.provider,
        data.providerId,
        encryptToken(data.token),
        data.refreshToken != null ? encryptToken(data.refreshToken) : null,
        data.expiresAt ?? null,
      ]
    )
    const account = SocialAccount.hydrate(rows[0] as Record<string, unknown>)
    void Emitter.emit('social_account:linked', {
      accountId: account.id,
      userId: account.userId,
      provider: account.provider,
      providerId: account.providerId,
    }).catch(() => {})
    return account
  }

  /**
   * Find an existing social account by `(provider, providerId)` or create a
   * new one. If the account already exists, its tokens are updated.
   *
   * SECURITY: This function does NOT validate the email. If the caller is
   * passing in an existing application `user` that was located by
   * `socialUser.email`, the caller MUST first verify
   * `socialUser.emailVerified === true`. Linking by an unverified
   * provider email is a known account-takeover vector — see the
   * "Verified-email gate" section in this package's CLAUDE.md.
   */
  static async findOrCreate(
    provider: string,
    socialUser: SocialUser,
    user: unknown
  ): Promise<{ account: SocialAccountData; created: boolean }> {
    const existing = await SocialAccount.findByProvider(provider, socialUser.id)
    if (existing) {
      await SocialAccount.updateTokens(
        existing.id,
        socialUser.token,
        socialUser.refreshToken,
        socialUser.expiresIn ? new Date(Date.now() + socialUser.expiresIn * 1000) : null
      )
      existing.token = socialUser.token
      existing.refreshToken = socialUser.refreshToken
      existing.expiresAt = socialUser.expiresIn
        ? new Date(Date.now() + socialUser.expiresIn * 1000)
        : null
      return { account: existing, created: false }
    }

    const account = await SocialAccount.create({
      user,
      provider,
      providerId: socialUser.id,
      token: socialUser.token,
      refreshToken: socialUser.refreshToken,
      expiresAt: socialUser.expiresIn ? new Date(Date.now() + socialUser.expiresIn * 1000) : null,
    })
    return { account, created: true }
  }

  /**
   * Update OAuth tokens for an existing social account. Tokens are
   * encrypted at rest — pass plaintext values; the column stores ciphertext.
   * Emits `social_account:tokens_updated` so an audit hook can record the
   * token swap.
   */
  static async updateTokens(
    id: number,
    token: string,
    refreshToken: string | null,
    expiresAt: Date | null
  ): Promise<void> {
    const encryptedToken = encryptToken(token)
    const encryptedRefresh = refreshToken != null ? encryptToken(refreshToken) : null
    await SocialAccount.sql`
      UPDATE "social_account"
      SET "token" = ${encryptedToken},
          "refresh_token" = ${encryptedRefresh},
          "expires_at" = ${expiresAt},
          "updated_at" = NOW()
      WHERE "id" = ${id}
    `
    void Emitter.emit('social_account:tokens_updated', {
      accountId: id,
      hasRefreshToken: refreshToken != null,
      expiresAt,
    }).catch(() => {})
  }

  /**
   * Delete a social account by its database ID. Emits
   * `social_account:unlinked` for the audit trail.
   */
  static async delete(id: number): Promise<void> {
    await SocialAccount.sql`
      DELETE FROM "social_account" WHERE "id" = ${id}
    `
    void Emitter.emit('social_account:unlinked', { accountId: id }).catch(() => {})
  }

  /** Delete all social accounts for a user. */
  static async deleteByUser(user: unknown): Promise<void> {
    const userId = extractUserId(user)
    const fk = SocialAccount.fk
    await SocialAccount.sql.unsafe(`DELETE FROM "social_account" WHERE "${fk}" = $1`, [userId])
    void Emitter.emit('social_account:unlinked_all', { userId }).catch(() => {})
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private static hydrate(row: Record<string, unknown>): SocialAccountData {
    const fk = SocialAccount.fk
    const rawRefresh = (row.refresh_token as string) ?? null
    return {
      id: row.id as number,
      userId: row[fk] as string | number,
      provider: row.provider as string,
      providerId: row.provider_id as string,
      token: decryptToken(row.token as string),
      refreshToken: rawRefresh != null ? decryptToken(rawRefresh) : null,
      expiresAt: (row.expires_at as Date) ?? null,
      createdAt: row.created_at as Date,
      updatedAt: row.updated_at as Date,
    }
  }
}
