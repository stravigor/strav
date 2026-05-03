import type { SQL } from 'bun'

/**
 * DDL for the built-in `tenant` registry table.
 *
 * Idempotent — safe to run repeatedly. Uses `gen_random_uuid()` so callers
 * can `INSERT INTO tenant (slug, name) VALUES (...)` without supplying an id.
 *
 * The table is global (not RLS-scoped). Other tenant-scoped tables reference
 * `tenant(id)` via their `tenant_id` column with `ON DELETE CASCADE`.
 */
export const TENANT_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS "tenant" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "slug" VARCHAR(255) NOT NULL,
  "name" VARCHAR(255) NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pk_tenant" PRIMARY KEY ("id"),
  CONSTRAINT "uq_tenant_slug" UNIQUE ("slug")
);
`.trim()

/** Apply the tenant table DDL using the given SQL client (use the bypass connection). */
export async function ensureTenantTable(sql: SQL): Promise<void> {
  await sql.unsafe(TENANT_TABLE_SQL)
}
