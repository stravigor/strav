/**
 * Tenant ID column type — configured via `database.tenant.idType` in app
 * config. Threads through schema generation, RLS DDL, and runtime
 * validation so that the same value is used everywhere consistently.
 */

export type TenantIdType = 'uuid' | 'bigint' | 'integer'

export const DEFAULT_TENANT_ID_TYPE: TenantIdType = 'bigint'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const BIGINT_RE = /^-?\d+$/

let currentIdType: TenantIdType = DEFAULT_TENANT_ID_TYPE

/** Set the tenant ID type for the running process. Called once during Database boot. */
export function setTenantIdType(idType: TenantIdType): void {
  currentIdType = idType
}

/** Read the tenant ID type for the running process. */
export function getTenantIdType(): TenantIdType {
  return currentIdType
}

/**
 * Reject tenant IDs that don't match the configured type's format. Run
 * before any SQL is bound so a malformed value never reaches Postgres.
 */
export function validateTenantId(idType: TenantIdType, value: string): void {
  if (idType === 'uuid') {
    if (!UUID_RE.test(value)) {
      throw new Error(`Invalid tenant id: ${value}. Must be a UUID.`)
    }
    return
  }
  // Both 'bigint' and 'integer' accept any decimal string; the database will
  // reject out-of-range values when the FK is bound.
  if (!BIGINT_RE.test(value)) {
    throw new Error(`Invalid tenant id: ${value}. Must be an integer.`)
  }
}

/**
 * Map the PK pgType of the tenant registry schema to the runtime cast
 * type used in RLS policies and FK column DEFAULTs.
 *
 *   serial / smallserial → integer
 *   bigserial            → bigint
 *   uuid                 → uuid
 */
export function tenantIdTypeFromPgType(pgType: string): TenantIdType {
  if (pgType === 'serial' || pgType === 'smallserial') return 'integer'
  if (pgType === 'bigserial') return 'bigint'
  if (pgType === 'uuid') return 'uuid'
  throw new Error(
    `Cannot derive tenant id type from PK pgType ${JSON.stringify(pgType)}. Allowed: serial, smallserial, bigserial, uuid.`
  )
}
