import { sql } from '@strav/database'

/**
 * Create the durable engine's two tables if they do not exist.
 *
 * Follows the `@strav/queue` precedent — inline, idempotent DDL rather than
 * a migration file (apps own their migrations directory). Safe to call on
 * every boot. Post-1.0 schema changes must be additive
 * (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`).
 *
 * - `_strav_workflow_runs`    — the durable record of a run; the pollable row.
 * - `_strav_workflow_journal` — the per-step checkpoint log;
 *   `UNIQUE (run_id, step_id)` is what makes redelivery idempotent.
 */
export async function ensureTables(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS "_strav_workflow_runs" (
      "id"                  BIGSERIAL PRIMARY KEY,
      "workflow_name"       VARCHAR(255) NOT NULL,
      "input"               JSONB NOT NULL DEFAULT '{}',
      "status"              VARCHAR(32)  NOT NULL DEFAULT 'pending',
      "state"               JSONB NOT NULL DEFAULT '{}',
      "current_step"        INT  NOT NULL DEFAULT 0,
      "compensation_cursor" INT,
      "parent_run_id"       BIGINT REFERENCES "_strav_workflow_runs"("id") ON DELETE CASCADE,
      "parent_step_id"      VARCHAR(512),
      "awaiting_signal"     VARCHAR(255),
      "wake_at"             TIMESTAMPTZ,
      "error"               TEXT,
      "result"              JSONB,
      "created_at"          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      "updated_at"          TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `

  await sql`
    CREATE INDEX IF NOT EXISTS "idx_strav_wf_runs_status"
      ON "_strav_workflow_runs" ("status")
  `

  await sql`
    CREATE INDEX IF NOT EXISTS "idx_strav_wf_runs_parent"
      ON "_strav_workflow_runs" ("parent_run_id")
  `

  await sql`
    CREATE TABLE IF NOT EXISTS "_strav_workflow_journal" (
      "id"           BIGSERIAL PRIMARY KEY,
      "run_id"       BIGINT NOT NULL REFERENCES "_strav_workflow_runs"("id") ON DELETE CASCADE,
      "step_id"      VARCHAR(512) NOT NULL,
      "status"       VARCHAR(16)  NOT NULL DEFAULT 'completed',
      "result"       JSONB,
      "error"        TEXT,
      "attempt"      INT NOT NULL DEFAULT 1,
      "completed_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE ("run_id", "step_id")
    )
  `

  await sql`
    CREATE INDEX IF NOT EXISTS "idx_strav_wf_journal_run"
      ON "_strav_workflow_journal" ("run_id")
  `
}

/** Drop the durable engine's tables. For testing only. */
export async function dropTables(): Promise<void> {
  await sql`DROP TABLE IF EXISTS "_strav_workflow_journal"`
  await sql`DROP TABLE IF EXISTS "_strav_workflow_runs"`
}
