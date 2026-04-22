// Manager
export { default, default as SearchManager } from './search_manager.ts'

// Provider
export { default as SearchProvider } from './search_provider.ts'

// Engine interface
export type { SearchEngine } from './search_engine.ts'

// Drivers
export { MeilisearchDriver } from './drivers/meilisearch_driver.ts'
export { TypesenseDriver } from './drivers/typesense_driver.ts'
export { AlgoliaDriver } from './drivers/algolia_driver.ts'
export { NullDriver } from './drivers/null_driver.ts'
export { EmbeddedDriver } from './drivers/embedded/index.ts'
export type {
  EmbeddedConfig,
  TypoToleranceMode,
  TypoToleranceSettings,
} from './drivers/embedded/index.ts'

// Mixin
export { searchable } from './searchable.ts'
export type { SearchableInstance, SearchableModel } from './searchable.ts'

// Helper
export { search } from './helpers.ts'

// Errors
export { SearchError, IndexNotFoundError, SearchQueryError } from './errors.ts'

// Types
export type {
  SearchConfig,
  DriverConfig,
  SearchDocument,
  SearchOptions,
  SearchResult,
  SearchHit,
  IndexSettings,
} from './types.ts'
