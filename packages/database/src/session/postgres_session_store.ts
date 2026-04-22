import type { SessionStore, SessionRecord } from '@strav/kernel/session/session_store'
import { inject } from '@strav/kernel/core/inject'
import Database from '../database/database.ts'

/**
 * Postgres-backed {@link SessionStore}. Persists sessions in `_strav_sessions`
 * using a JSONB column for the data bag. Uses `INSERT … ON CONFLICT` for
 * idempotent saves.
 */
@inject
export default class PostgresSessionStore implements SessionStore {
  constructor(private db: Database) {}

  async ensureSchema(): Promise<void> {
    await this.db.sql`
      CREATE TABLE IF NOT EXISTS "_strav_sessions" (
        "id"            UUID PRIMARY KEY,
        "user_id"       VARCHAR(255),
        "csrf_token"    VARCHAR(64) NOT NULL,
        "data"          JSONB NOT NULL DEFAULT '{}',
        "ip_address"    VARCHAR(45),
        "user_agent"    TEXT,
        "last_activity" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "created_at"    TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `
  }

  async find(id: string): Promise<SessionRecord | null> {
    const rows = await this.db.sql`
      SELECT * FROM "_strav_sessions" WHERE "id" = ${id} LIMIT 1
    `
    if (rows.length === 0) return null
    return PostgresSessionStore.hydrate(rows[0] as Record<string, unknown>)
  }

  async save(record: SessionRecord): Promise<void> {
    await this.db.sql`
      INSERT INTO "_strav_sessions"
        ("id", "user_id", "csrf_token", "data", "ip_address", "user_agent", "last_activity")
      VALUES
        (${record.id}, ${record.userId}, ${record.csrfToken},
         ${JSON.stringify(record.data)}::jsonb, ${record.ipAddress}, ${record.userAgent}, NOW())
      ON CONFLICT ("id") DO UPDATE SET
        "user_id"       = EXCLUDED."user_id",
        "csrf_token"    = EXCLUDED."csrf_token",
        "data"          = EXCLUDED."data",
        "last_activity" = NOW()
    `
  }

  async destroy(id: string): Promise<void> {
    await this.db.sql`DELETE FROM "_strav_sessions" WHERE "id" = ${id}`
  }

  async touch(id: string): Promise<void> {
    await this.db.sql`
      UPDATE "_strav_sessions"
      SET "last_activity" = NOW()
      WHERE "id" = ${id}
    `
  }

  async gc(cutoff: Date): Promise<number> {
    const rows = await this.db.sql`
      DELETE FROM "_strav_sessions"
      WHERE "last_activity" < ${cutoff}
      RETURNING "id"
    `
    return rows.length
  }

  private static hydrate(row: Record<string, unknown>): SessionRecord {
    const rawData = row.data
    const data: Record<string, unknown> =
      typeof rawData === 'string'
        ? JSON.parse(rawData)
        : ((rawData as Record<string, unknown>) ?? {})

    return {
      id: row.id as string,
      userId: (row.user_id as string) ?? null,
      csrfToken: row.csrf_token as string,
      data,
      ipAddress: (row.ip_address as string) ?? null,
      userAgent: (row.user_agent as string) ?? null,
      lastActivity: row.last_activity as Date,
      createdAt: row.created_at as Date,
    }
  }
}
