/**
 * Tenant table & FK column name — configured via `database.tenant.tableName`.
 * Threads through schema generation, the RLS DDL helpers, the migration
 * generator, the trigger function, and the built-in `Tenant` model.
 *
 * The FK column on tenanted children is derived as `${tableName}_id`. The
 * internal session-config key (`app.tenant_id`) is *not* renamed — it's a
 * framework-private setting that has no user-facing meaning.
 */

export const DEFAULT_TENANT_TABLE_NAME = 'tenant'

/** snake_case identifier — letters, digits, underscores; doesn't start with a digit. */
const IDENTIFIER_RE = /^[a-z_][a-z0-9_]*$/

let currentTableName: string = DEFAULT_TENANT_TABLE_NAME

/**
 * Validate a user-supplied tenant table name. We interpolate the value
 * directly into DDL so we must reject anything that isn't a plain
 * snake_case identifier.
 */
export function validateTenantTableName(name: string): void {
  if (!IDENTIFIER_RE.test(name)) {
    throw new Error(
      `Invalid tenant table name: ${JSON.stringify(name)}. Must be a snake_case identifier (lowercase letters, digits, underscores; cannot start with a digit).`
    )
  }
}

/** Set the tenant table name for the running process. Called once during Database boot. */
export function setTenantTableName(name: string): void {
  validateTenantTableName(name)
  currentTableName = name
}

/** Read the tenant table name for the running process. */
export function getTenantTableName(): string {
  return currentTableName
}

/** Derive the FK column on tenanted children: `${tableName}_id`. */
export function tenantFkColumnFor(tableName: string): string {
  return `${tableName}_id`
}
