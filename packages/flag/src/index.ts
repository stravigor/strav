// Manager
export { default, default as FlagManager } from './flag_manager.ts'

// Provider
export { default as FlagProvider } from './flag_provider.ts'
export type { FlagProviderOptions } from './flag_provider.ts'

// Helper
export { flag } from './helpers.ts'

// Store interface
export type { FeatureStore } from './feature_store.ts'

// Drivers
export { DatabaseDriver } from './drivers/database_driver.ts'
export { ArrayDriver } from './drivers/array_driver.ts'

// Scoped API
export { default as PendingScopedFeature } from './pending_scope.ts'

// Middleware
export { ensureFeature } from './middleware/ensure_feature.ts'

// Errors
export { FlagError, FeatureNotDefinedError, MissingScopeError } from './errors.ts'

// Types
export type {
  FlagConfig,
  DriverConfig,
  Scopeable,
  ScopeKey,
  StoredFeature,
  FeatureResolver,
  FeatureClass,
  FeatureClassConstructor,
  FlagActor,
  FlagUpdatedEvent,
} from './types.ts'
export { GLOBAL_SCOPE } from './types.ts'
