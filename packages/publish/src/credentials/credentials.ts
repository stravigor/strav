import { EncryptionManager } from '@strav/kernel'
import PublishManager from '../publisher_manager.ts'

const ENC_PREFIX = 'enc:v1:'

function encryptToken(plain: string): string {
  return ENC_PREFIX + EncryptionManager.encrypt(plain)
}

function decryptToken(stored: string): string {
  // Legacy plaintext rows (no enc:v1: prefix) are returned as-is and
  // re-encrypted on the next updateTokens() call — matches the
  // @strav/social compatibility shim.
  if (!stored.startsWith(ENC_PREFIX)) return stored
  return EncryptionManager.decrypt(stored.slice(ENC_PREFIX.length))
}

/**
 * The DB record for a stored publisher credential.
 *
 * `accessToken` and `refreshToken` are plaintext in this shape (decrypted
 * on read). Don't pass these around outside the publisher boundary.
 */
export interface PublisherCredentialsData {
  id: number
  tenantId: string | number
  platform: string
  accountId: string
  accessToken: string
  refreshToken: string | null
  expiresAt: Date | null
  scopes: string[] | null
  metadata: Record<string, unknown> | null
  createdAt: Date
  updatedAt: Date
}

interface CreateInput {
  tenantId: string | number
  platform: string
  accountId: string
  accessToken: string
  refreshToken?: string | null
  expiresAt?: Date | null
  scopes?: string[] | null
  metadata?: Record<string, unknown> | null
}

interface UpdateTokensInput {
  accessToken: string
  refreshToken?: string | null
  expiresAt?: Date | null
}

/**
 * Static helper for managing publisher credential rows.
 *
 * Mirrors @strav/social's SocialAccount pattern — all methods are static,
 * database access goes through PublisherManager.db, and tokens are
 * encrypted at rest via EncryptionManager.
 *
 * Most apps should not call these methods directly; PublisherManager
 * handles read + refresh + write as part of dispatching a publish.
 */
export default class PublisherCredentials {
  private static get sql() {
    return PublishManager.db.sql
  }

  private static get tenantFk(): string {
    return PublishManager.tenantFkColumn
  }

  /** Look up a credential by (tenant, platform, accountId). */
  static async find(
    tenantId: string | number,
    platform: string,
    accountId: string
  ): Promise<PublisherCredentialsData | null> {
    const fk = PublisherCredentials.tenantFk
    const rows = await PublisherCredentials.sql.unsafe(
      `SELECT * FROM "publisher_credentials"
       WHERE "${fk}" = $1 AND "platform" = $2 AND "account_id" = $3
       LIMIT 1`,
      [tenantId, platform, accountId]
    )
    return rows.length > 0
      ? PublisherCredentials.hydrate(rows[0] as Record<string, unknown>)
      : null
  }

  /**
   * Find the first credential for a (tenant, platform) pair. Convenient
   * shortcut for the common case where a tenant has one account per
   * platform.
   */
  static async findOne(
    tenantId: string | number,
    platform: string
  ): Promise<PublisherCredentialsData | null> {
    const fk = PublisherCredentials.tenantFk
    const rows = await PublisherCredentials.sql.unsafe(
      `SELECT * FROM "publisher_credentials"
       WHERE "${fk}" = $1 AND "platform" = $2
       ORDER BY "created_at" ASC
       LIMIT 1`,
      [tenantId, platform]
    )
    return rows.length > 0
      ? PublisherCredentials.hydrate(rows[0] as Record<string, unknown>)
      : null
  }

  /** List every credential for a tenant. */
  static async findByTenant(tenantId: string | number): Promise<PublisherCredentialsData[]> {
    const fk = PublisherCredentials.tenantFk
    const rows = await PublisherCredentials.sql.unsafe(
      `SELECT * FROM "publisher_credentials" WHERE "${fk}" = $1 ORDER BY "created_at" ASC`,
      [tenantId]
    )
    return rows.map((r: unknown) =>
      PublisherCredentials.hydrate(r as Record<string, unknown>)
    )
  }

  static async create(data: CreateInput): Promise<PublisherCredentialsData> {
    const fk = PublisherCredentials.tenantFk
    const rows = await PublisherCredentials.sql.unsafe(
      `INSERT INTO "publisher_credentials"
         ("${fk}", "platform", "account_id", "access_token", "refresh_token", "expires_at", "scopes", "metadata")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [
        data.tenantId,
        data.platform,
        data.accountId,
        encryptToken(data.accessToken),
        data.refreshToken != null ? encryptToken(data.refreshToken) : null,
        data.expiresAt ?? null,
        data.scopes != null ? JSON.stringify(data.scopes) : null,
        data.metadata != null ? JSON.stringify(data.metadata) : null,
      ]
    )
    return PublisherCredentials.hydrate(rows[0] as Record<string, unknown>)
  }

  /**
   * Update only the OAuth tokens + expiry. Used by the refresh path so
   * `metadata` and `scopes` are preserved.
   */
  static async updateTokens(
    id: number,
    update: UpdateTokensInput
  ): Promise<PublisherCredentialsData> {
    const rows = await PublisherCredentials.sql.unsafe(
      `UPDATE "publisher_credentials"
         SET "access_token" = $1,
             "refresh_token" = COALESCE($2, "refresh_token"),
             "expires_at" = $3,
             "updated_at" = NOW()
       WHERE "id" = $4
       RETURNING *`,
      [
        encryptToken(update.accessToken),
        update.refreshToken != null ? encryptToken(update.refreshToken) : null,
        update.expiresAt ?? null,
        id,
      ]
    )
    if (rows.length === 0) {
      throw new Error(`PublisherCredentials id ${id} not found`)
    }
    return PublisherCredentials.hydrate(rows[0] as Record<string, unknown>)
  }

  /** Upsert by (tenant, platform, accountId). */
  static async upsert(data: CreateInput): Promise<PublisherCredentialsData> {
    const existing = await PublisherCredentials.find(data.tenantId, data.platform, data.accountId)
    if (!existing) return PublisherCredentials.create(data)

    return PublisherCredentials.updateTokens(existing.id, {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken ?? null,
      expiresAt: data.expiresAt ?? null,
    })
  }

  static async delete(id: number): Promise<void> {
    await PublisherCredentials.sql.unsafe(
      `DELETE FROM "publisher_credentials" WHERE "id" = $1`,
      [id]
    )
  }

  /**
   * Determine whether the access token is currently usable.
   * `skewSeconds` widens the window so a token that expires in the very
   * near future is treated as already expired (avoids the race where we
   * dispatch a call with a token that dies mid-flight).
   */
  static isExpired(credentials: PublisherCredentialsData, skewSeconds = 60): boolean {
    if (!credentials.expiresAt) return false
    return credentials.expiresAt.getTime() - skewSeconds * 1000 <= Date.now()
  }

  private static hydrate(row: Record<string, unknown>): PublisherCredentialsData {
    const expiresAt = row.expires_at ? new Date(row.expires_at as string | Date) : null
    const createdAt = new Date(row.created_at as string | Date)
    const updatedAt = new Date(row.updated_at as string | Date)
    const accessToken = decryptToken(row.access_token as string)
    const refreshTokenRaw = row.refresh_token as string | null
    const refreshToken = refreshTokenRaw != null ? decryptToken(refreshTokenRaw) : null
    const scopes = parseJson<string[]>(row.scopes)
    const metadata = parseJson<Record<string, unknown>>(row.metadata)

    return {
      id: Number(row.id),
      tenantId: row[PublisherCredentials.tenantFk] as string | number,
      platform: String(row.platform),
      accountId: String(row.account_id),
      accessToken,
      refreshToken,
      expiresAt,
      scopes,
      metadata,
      createdAt,
      updatedAt,
    }
  }
}

function parseJson<T>(value: unknown): T | null {
  if (value == null) return null
  if (typeof value === 'object') return value as T
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T
    } catch {
      return null
    }
  }
  return null
}
