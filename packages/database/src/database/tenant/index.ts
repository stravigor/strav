export {
  type TenantContext,
  tenantStorage,
  withTenant,
  withoutTenant,
  getCurrentTenantContext,
  getCurrentTenantId,
  hasTenantContext,
  isBypassingTenant,
} from './context'

export { createTenantAwareSQL } from './wrapper'

export {
  tenantIdColumnDDL,
  enableRLSStatements,
  disableRLSStatements,
  createTenantPolicyStatement,
  dropTenantPolicyStatement,
  tenantIndexStatement,
} from './policies'

export { default as TenantManager } from './manager'
export type { TenantRecord, TenantStats } from './manager'

export { TENANT_TABLE_SQL, ensureTenantTable } from './seed'
