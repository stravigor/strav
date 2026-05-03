/**
 * SQL helpers for PostgreSQL row-level security DDL.
 *
 * Used by the migration generator and the tenants seed migration.
 */

const POLICY_NAME = 'tenant_isolation'

export function tenantIdColumnDDL(): string {
  return `"tenant_id" UUID NOT NULL DEFAULT current_setting('app.tenant_id', true)::uuid REFERENCES "tenant" ("id") ON DELETE CASCADE`
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

export function createTenantPolicyStatement(table: string): string {
  return (
    `CREATE POLICY "${POLICY_NAME}" ON "${table}" ` +
    `USING ("tenant_id" = current_setting('app.tenant_id', true)::uuid) ` +
    `WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);`
  )
}

export function dropTenantPolicyStatement(table: string): string {
  return `DROP POLICY IF EXISTS "${POLICY_NAME}" ON "${table}";`
}

export function tenantIndexStatement(table: string, pkColumn: string): string {
  return `CREATE INDEX IF NOT EXISTS "idx_${table}_tenant_id_${pkColumn}" ON "${table}" ("tenant_id", "${pkColumn}");`
}
