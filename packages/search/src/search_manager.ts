import { inject, Configuration, ConfigurationError } from '@strav/kernel'
import type { SearchEngine } from './search_engine.ts'
import type { SearchConfig, DriverConfig } from './types.ts'
import { MeilisearchDriver } from './drivers/meilisearch_driver.ts'
import { TypesenseDriver } from './drivers/typesense_driver.ts'
import { AlgoliaDriver } from './drivers/algolia_driver.ts'
import { NullDriver } from './drivers/null_driver.ts'
import { EmbeddedDriver } from './drivers/embedded/index.ts'

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

  /** Resolve a full index name by applying the configured prefix. */
  static indexName(name: string): string {
    return SearchManager.prefix ? `${SearchManager.prefix}${name}` : name
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
      case 'null':
        return new NullDriver()
      default:
        throw new ConfigurationError(
          `Unknown search driver "${driverName}". Register it with SearchManager.extend().`
        )
    }
  }
}
