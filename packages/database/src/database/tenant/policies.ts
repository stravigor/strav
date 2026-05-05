/**
 * SQL helpers for PostgreSQL row-level security DDL.
 *
 * Used by the migration generator and the tenants seed migration. The
 * `idType` argument controls whether the column type and policy cast use
 * `uuid` or `bigint`.
 */

import type { TenantIdType } from './id_type'

const POLICY_NAME = 'tenant_isolation'

export function tenantIdColumnDDL(idType: TenantIdType): string {
  const sqlType = idType === 'uuid' ? 'UUID' : 'BIGINT'
  return `"tenant_id" ${sqlType} NOT NULL DEFAULT current_setting('app.tenant_id', true)::${idType} REFERENCES "tenant" ("id") ON DELETE CASCADE`
}

export function enableRLSStatements(table: string): string[] {
  return [
    `ALTER TABLE "${table}" ENABLE ROW LEVEL SECURITY;`,
    `ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY;`,
  ]
}

export function disableRLSStatements(table: string): string[] {
  return [
    `ALTER TABLE "${table}" NO FORCE ROW LEVEL SECURITY;`,
    `ALTER TABLE "${table}" DISABLE ROW LEVEL SECURITY;`,
  ]
}

export function createTenantPolicyStatement(table: string, idType: TenantIdType): string {
  const cast = `current_setting('app.tenant_id', true)::${idType}`
  return (
    `CREATE POLICY "${POLICY_NAME}" ON "${table}" ` +
    `USING ("tenant_id" = ${cast}) ` +
    `WITH CHECK ("tenant_id" = ${cast});`
  )
}

export function dropTenantPolicyStatement(table: string): string {
  return `DROP POLICY IF EXISTS "${POLICY_NAME}" ON "${table}";`
}

export function tenantIndexStatement(table: string, pkColumn: string): string {
  return `CREATE INDEX IF NOT EXISTS "idx_${table}_tenant_id_${pkColumn}" ON "${table}" ("tenant_id", "${pkColumn}");`
}
