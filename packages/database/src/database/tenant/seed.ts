import type { SQL } from 'bun'
import type { TenantIdType } from './id_type'

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
