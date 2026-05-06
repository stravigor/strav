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

export {
  tenantTableSQL,
  ensureTenantTable,
  tenantSequencesTableSQL,
  tenantAssignFunctionSQL,
  ensureTenantSequencesObjects,
} from './seed'

export {
  type TenantIdType,
  DEFAULT_TENANT_ID_TYPE,
  setTenantIdType,
  getTenantIdType,
  validateTenantId,
} from './id_type'

export {
  DEFAULT_TENANT_TABLE_NAME,
  setTenantTableName,
  getTenantTableName,
  validateTenantTableName,
  tenantFkColumnFor,
} from './naming'
