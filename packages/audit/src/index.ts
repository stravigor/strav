export { default, default as AuditManager, canonicalize, hashFor } from './audit_manager.ts'
export { default as AuditProvider } from './audit_provider.ts'
export type { AuditProviderOptions } from './audit_provider.ts'

export { audit, PendingAuditEvent } from './helpers.ts'
export { auditQuery, resolveTimeBound } from './queries.ts'
export { verifyChain } from './integrity.ts'
export { diff, jsonEqual } from './diff.ts'

export { DatabaseAuditDriver } from './drivers/database_driver.ts'
export { MemoryAuditDriver } from './drivers/memory_driver.ts'

export { AuditError, ChainBrokenError } from './errors.ts'

export type {
  AuditEvent,
  AuditDiff,
  AuditActor,
  AuditActorLike,
  AuditConfig,
  AuditStore,
  AuditQueryOptions,
  AuditRangeOptions,
  AuditChainResult,
  TimeBound,
} from './types.ts'
