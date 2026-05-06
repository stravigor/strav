import type { SQL } from 'bun'
import type { TenantIdType } from './id_type'
import {
  enableRLSStatements,
  createTenantPolicyStatement,
} from './policies'

/**
 * DDL for the built-in `tenant` registry table.
 *
 * Idempotent — safe to run repeatedly. The PK column type follows the
 * configured tenant ID type:
 *   - `'uuid'`   → `UUID NOT NULL DEFAULT gen_random_uuid()`
 *   - `'bigint'` → `BIGSERIAL NOT NULL`
 *
 * Either way callers can `INSERT INTO tenant (slug, name) VALUES (...)`
 * without supplying an id. The table is global (not RLS-scoped); other
 * tenant-scoped tables reference `tenant(id)` via their `tenant_id`
 * column with `ON DELETE CASCADE`.
 */
export function tenantTableSQL(idType: TenantIdType): string {
  const idColumn =
    idType === 'uuid'
      ? `"id" UUID NOT NULL DEFAULT gen_random_uuid()`
      : `"id" BIGSERIAL NOT NULL`
  return `
CREATE TABLE IF NOT EXISTS "tenant" (
  ${idColumn},
  "slug" VARCHAR(255) NOT NULL,
  "name" VARCHAR(255) NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "pk_tenant" PRIMARY KEY ("id"),
  CONSTRAINT "uq_tenant_slug" UNIQUE ("slug")
);
`.trim()
}

/** Apply the tenant table DDL using the given SQL client (use the bypass connection). */
export async function ensureTenantTable(sql: SQL, idType: TenantIdType): Promise<void> {
  await sql.unsafe(tenantTableSQL(idType))
}

/**
 * DDL for the per-tenant id counter table. One row per `(tenant_id, table_name)`
 * pair tracks the next id to issue for that tenant on that table. Cascades on
 * tenant deletion. RLS-protected so app-role queries never see another tenant's
 * counters.
 */
export function tenantSequencesTableSQL(idType: TenantIdType): string {
  const sqlType = idType === 'uuid' ? 'UUID' : 'BIGINT'
  return `
CREATE TABLE IF NOT EXISTS "_strav_tenant_sequences" (
  "tenant_id"  ${sqlType} NOT NULL REFERENCES "tenant" ("id") ON DELETE CASCADE,
  "table_name" TEXT NOT NULL,
  "next_value" BIGINT NOT NULL DEFAULT 1,
  CONSTRAINT "pk__strav_tenant_sequences" PRIMARY KEY ("tenant_id", "table_name")
);
${enableRLSStatements('_strav_tenant_sequences').join('\n')}
DROP POLICY IF EXISTS "tenant_isolation" ON "_strav_tenant_sequences";
${createTenantPolicyStatement('_strav_tenant_sequences', idType)}
GRANT SELECT, INSERT, UPDATE, DELETE ON "_strav_tenant_sequences" TO PUBLIC;
`.trim()
}

/**
 * BEFORE INSERT trigger function shared by every tenantedSerial table. If
 * `NEW.id` is already set, leave it alone (passthrough, like SERIAL). Otherwise
 * UPSERT the counter row and assign `NEW.id = next_value - 1` (atomic via
 * row-level lock on `(tenant_id, table_name)`).
 */
export function tenantAssignFunctionSQL(): string {
  return `
CREATE OR REPLACE FUNCTION strav_assign_tenanted_id() RETURNS TRIGGER AS $$
DECLARE
  assigned BIGINT;
BEGIN
  IF NEW.id IS NOT NULL THEN
    RETURN NEW;
  END IF;
  INSERT INTO "_strav_tenant_sequences" ("tenant_id", "table_name", "next_value")
  VALUES (NEW.tenant_id, TG_TABLE_NAME, 2)
  ON CONFLICT ("tenant_id", "table_name")
  DO UPDATE SET "next_value" = "_strav_tenant_sequences"."next_value" + 1
  RETURNING "next_value" - 1 INTO assigned;
  NEW.id := assigned;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql
SET search_path = pg_catalog, public;
`.trim()
}

/**
 * Idempotent setup for the per-tenant sequencing infrastructure. Safe to call
 * on every boot. Runs against the bypass connection so RLS doesn't filter the
 * DDL statements.
 */
export async function ensureTenantSequencesObjects(
  sql: SQL,
  idType: TenantIdType
): Promise<void> {
  await sql.unsafe(tenantSequencesTableSQL(idType))
  await sql.unsafe(tenantAssignFunctionSQL())
}
