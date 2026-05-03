import type Database from '../database'
import type { MigrationRecord } from './types'

const TABLE_NAME = '_strav_migrations'

/**
 * Manages the migration tracking table.
 *
 * Records which migration versions have been applied and groups them into
 * batches so rollbacks can undo an entire batch at once. All operations
 * route through the bypass connection so they are not filtered by RLS.
 */
export default class MigrationTracker {
  constructor(private db: Database) {}

  /** Create the tracking table if it does not exist. */
  async ensureTable(): Promise<void> {
    await this.db.bypass.unsafe(`
      CREATE TABLE IF NOT EXISTS ${TABLE_NAME} (
        id SERIAL PRIMARY KEY,
        version VARCHAR(255) NOT NULL,
        batch INTEGER NOT NULL,
        executed_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
      )
    `)
  }

  /** Return all applied migration records ordered by version. */
  async getAppliedMigrations(): Promise<MigrationRecord[]> {
    return (await this.db.bypass.unsafe(
      `SELECT id, version, batch, executed_at FROM ${TABLE_NAME} ORDER BY version`
    )) as MigrationRecord[]
  }

  /** Given a list of all known versions, return those not yet applied. */
  async getPendingVersions(allVersions: string[]): Promise<string[]> {
    const applied = await this.getAppliedMigrations()
    const appliedSet = new Set(applied.map(r => r.version))
    return allVersions.filter(v => !appliedSet.has(v))
  }

  /** Return the highest batch number, or 0 if no migrations exist. */
  async getLastBatch(): Promise<number> {
    const rows = await this.db.bypass.unsafe(
      `SELECT COALESCE(MAX(batch), 0) AS max_batch FROM ${TABLE_NAME}`
    )
    return (rows[0] as any).max_batch
  }

  /** Record a migration as applied. */
  async recordMigration(version: string, batch: number): Promise<void> {
    await this.db.bypass.unsafe(
      `INSERT INTO ${TABLE_NAME} (version, batch) VALUES ($1, $2)`,
      [version, batch]
    )
  }

  /** Remove a migration record by version. */
  async removeMigration(version: string): Promise<void> {
    await this.db.bypass.unsafe(`DELETE FROM ${TABLE_NAME} WHERE version = $1`, [version])
  }

  /** Return all migrations for a specific batch. */
  async getMigrationsByBatch(batch: number): Promise<MigrationRecord[]> {
    return (await this.db.bypass.unsafe(
      `SELECT id, version, batch, executed_at FROM ${TABLE_NAME} WHERE batch = $1 ORDER BY version DESC`,
      [batch]
    )) as MigrationRecord[]
  }

  /** Return migrations from the latest batch (most recent run). */
  async getLatestBatchMigrations(): Promise<MigrationRecord[]> {
    const lastBatch = await this.getLastBatch()
    if (lastBatch === 0) return []
    return this.getMigrationsByBatch(lastBatch)
  }
}
