import { inject, Configuration, ConfigurationError } from '@strav/kernel'
import type { SearchEngine } from './search_engine.ts'
import type { SearchConfig, DriverConfig, SearchScope } from './types.ts'
import { MeilisearchDriver } from './drivers/meilisearch_driver.ts'
import { TypesenseDriver } from './drivers/typesense_driver.ts'
import { AlgoliaDriver } from './drivers/algolia_driver.ts'
import { NullDriver } from './drivers/null_driver.ts'
import { EmbeddedDriver } from './drivers/embedded/index.ts'
import { PostgresFtsDriver } from './drivers/postgres/index.ts'

@inject
export default class SearchManager {
  private static _config: SearchConfig
  private static _engines = new Map<string, SearchEngine>()
  private static _extensions = new Map<string, (config: DriverConfig) => SearchEngine>()

  constructor(config: Configuration) {
    SearchManager._config = {
      default: config.get('search.default', 'null') as string,
      prefix: config.get('search.prefix', '') as string,
      drivers: config.get('search.drivers', {}) as Record<string, DriverConfig>,
    }
  }

  static get config(): SearchConfig {
    if (!SearchManager._config) {
      throw new ConfigurationError(
        'SearchManager not configured. Resolve it through the container first.'
      )
    }
    return SearchManager._config
  }

  /** Get an engine by name, or the default engine. Engines are lazily created. */
  static engine(name?: string): SearchEngine {
    const key = name ?? SearchManager.config.default

    let engine = SearchManager._engines.get(key)
    if (engine) return engine

    const driverConfig = SearchManager.config.drivers[key]
    if (!driverConfig) {
      throw new ConfigurationError(`Search driver "${key}" is not configured.`)
    }

    engine = SearchManager.createEngine(key, driverConfig)
    SearchManager._engines.set(key, engine)
    return engine
  }

  /** The index name prefix from configuration. */
  static get prefix(): string {
    return SearchManager._config?.prefix ?? ''
  }

  /**
   * Resolve a full index name by applying the configured prefix and
   * optional per-tenant scope. Per-tenant scoping namespaces the index
   * as `${prefix}t${tenantId}_${name}` so two tenants on the same
   * shared engine cannot read or overwrite each other's documents.
   *
   * Apps that don't need multi-tenant isolation can omit the scope.
   * The driver layer is unchanged — namespacing happens here at the
   * manager boundary.
   */
  static indexName(name: string, scope?: SearchScope | null): string {
    const base = SearchManager.prefix ? `${SearchManager.prefix}${name}` : name
    if (!scope || scope.tenantId === undefined || scope.tenantId === null) return base
    // Validate tenant identifier — anything that ends up in an index
    // name lands in URL paths / SQL identifiers downstream, so refuse
    // values that could escape the namespace. Letters, digits, dashes,
    // underscores only.
    const tenantId = String(scope.tenantId)
    if (!/^[a-zA-Z0-9_-]+$/.test(tenantId)) {
      throw new ConfigurationError(
        `SearchManager.indexName: invalid tenantId ${JSON.stringify(tenantId)} — ` +
          `must match /^[a-zA-Z0-9_-]+$/.`
      )
    }
    if (SearchManager.prefix) {
      return `${SearchManager.prefix}t${tenantId}_${name}`
    }
    return `t${tenantId}_${name}`
  }

  /** Register a custom driver factory. */
  static extend(name: string, factory: (config: DriverConfig) => SearchEngine): void {
    SearchManager._extensions.set(name, factory)
  }

  /** Replace an engine at runtime (e.g. for testing). */
  static useEngine(engine: SearchEngine): void {
    SearchManager._engines.set(engine.name, engine)
  }

  /** Reset all state. Intended for test teardown. */
  static reset(): void {
    SearchManager._engines.clear()
    SearchManager._extensions.clear()
    SearchManager._config = undefined as any
  }

  private static createEngine(name: string, config: DriverConfig): SearchEngine {
    const driverName = config.driver ?? name

    const extension = SearchManager._extensions.get(driverName)
    if (extension) return extension(config)

    switch (driverName) {
      case 'meilisearch':
        return new MeilisearchDriver(config)
      case 'typesense':
        return new TypesenseDriver(config)
      case 'algolia':
        return new AlgoliaDriver(config)
      case 'embedded':
        return new EmbeddedDriver(config)
      case 'postgres-fts':
      case 'postgres':
        return new PostgresFtsDriver(config)
      case 'null':
        return new NullDriver()
      default:
        throw new ConfigurationError(
          `Unknown search driver "${driverName}". Register it with SearchManager.extend().`
        )
    }
  }
}
