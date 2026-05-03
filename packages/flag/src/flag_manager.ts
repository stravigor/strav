import { inject, Configuration, Emitter, ConfigurationError } from '@strav/kernel'
import { Database } from '@strav/database'
import type {
  FlagConfig,
  DriverConfig,
  FeatureResolver,
  FeatureClassConstructor,
  FlagActor,
  ScopeKey,
  Scopeable,
} from './types.ts'
import { GLOBAL_SCOPE } from './types.ts'
import type { FeatureStore } from './feature_store.ts'
import { DatabaseDriver } from './drivers/database_driver.ts'
import { ArrayDriver } from './drivers/array_driver.ts'
import { FeatureNotDefinedError } from './errors.ts'
import PendingScopedFeature from './pending_scope.ts'

@inject
export default class FlagManager {
  private static _config: FlagConfig
  private static _db: Database
  private static _stores = new Map<string, FeatureStore>()
  private static _extensions = new Map<string, (config: DriverConfig) => FeatureStore>()
  private static _definitions = new Map<string, FeatureResolver>()
  private static _classFeatures = new Map<string, FeatureClassConstructor>()
  private static _cache = new Map<string, unknown>()

  constructor(db: Database, config: Configuration) {
    FlagManager._db = db
    FlagManager._config = {
      default: config.get('flag.default', 'database') as string,
      drivers: config.get('flag.drivers', {}) as Record<string, DriverConfig>,
    }
  }

  // ── Configuration ──────────────────────────────────────────────────

  static get config(): FlagConfig {
    if (!FlagManager._config) {
      throw new ConfigurationError(
        'FlagManager not configured. Resolve it through the container first.'
      )
    }
    return FlagManager._config
  }

  // ── Feature definitions ────────────────────────────────────────────

  static define(name: string, resolver: FeatureResolver | boolean): void {
    if (typeof resolver === 'boolean') {
      const val = resolver
      FlagManager._definitions.set(name, () => val)
    } else {
      FlagManager._definitions.set(name, resolver)
    }
  }

  static defineClass(feature: FeatureClassConstructor): void {
    const key = feature.key ?? toKebab(feature.name)
    FlagManager._classFeatures.set(key, feature)
  }

  /** Get all defined feature names (closures + classes). */
  static defined(): string[] {
    return [...FlagManager._definitions.keys(), ...FlagManager._classFeatures.keys()]
  }

  // ── Scope helpers ──────────────────────────────────────────────────

  static serializeScope(scope: Scopeable | null | undefined): ScopeKey {
    if (!scope) return GLOBAL_SCOPE
    const type =
      typeof scope.featureScope === 'function' ? scope.featureScope() : scope.constructor.name
    return `${type}:${scope.id}`
  }

  // ── Core resolution ────────────────────────────────────────────────

  static async value(feature: string, scope?: Scopeable | null): Promise<unknown> {
    const scopeKey = FlagManager.serializeScope(scope)
    const cacheKey = FlagManager.cacheKey(feature, scopeKey)

    // 1. Check in-memory cache
    if (FlagManager._cache.has(cacheKey)) {
      return FlagManager._cache.get(cacheKey)
    }

    // 2. Check store
    const store = FlagManager.store()
    const stored = await store.get(feature, scopeKey)
    if (stored !== undefined) {
      FlagManager._cache.set(cacheKey, stored)
      return stored
    }

    // 3. Resolve
    const value = await FlagManager.resolveFeature(feature, scopeKey)

    // 4. Persist
    await store.set(feature, scopeKey, value)
    FlagManager._cache.set(cacheKey, value)

    await Emitter.emit('flag:resolved', { feature, scope: scopeKey, value })

    return value
  }

  static async active(feature: string, scope?: Scopeable | null): Promise<boolean> {
    return Boolean(await FlagManager.value(feature, scope))
  }

  static async inactive(feature: string, scope?: Scopeable | null): Promise<boolean> {
    return !(await FlagManager.active(feature, scope))
  }

  static async when<TActive, TInactive>(
    feature: string,
    onActive: (value: unknown) => TActive | Promise<TActive>,
    onInactive: () => TInactive | Promise<TInactive>,
    scope?: Scopeable | null
  ): Promise<TActive | TInactive> {
    const value = await FlagManager.value(feature, scope)
    return value ? onActive(value) : onInactive()
  }

  // ── Scoped API ─────────────────────────────────────────────────────

  static for(scope: Scopeable): PendingScopedFeature {
    return new PendingScopedFeature(scope)
  }

  // ── Manual activation/deactivation ─────────────────────────────────

  /**
   * Turn a flag on (or assign a rich value).
   *
   * Pass `actor` to record who made the change — the value is included
   * in the `flag:updated` event payload so an audit hook can wire it
   * through to `@strav/audit`. See the package CLAUDE.md for the
   * recommended one-liner pattern.
   */
  static async activate(
    feature: string,
    value?: unknown,
    scope?: Scopeable | null,
    actor?: FlagActor | null
  ): Promise<void> {
    const scopeKey = FlagManager.serializeScope(scope)
    const resolved = value !== undefined ? value : true
    const previous = await FlagManager.store().get(feature, scopeKey)
    await FlagManager.store().set(feature, scopeKey, resolved)
    FlagManager._cache.set(FlagManager.cacheKey(feature, scopeKey), resolved)
    await Emitter.emit('flag:updated', {
      feature,
      scope: scopeKey,
      value: resolved,
      previous,
      actor: actor ?? null,
    })
  }

  /**
   * Turn a flag off.
   *
   * Pass `actor` to record who made the change — see {@link activate}.
   */
  static async deactivate(
    feature: string,
    scope?: Scopeable | null,
    actor?: FlagActor | null
  ): Promise<void> {
    const scopeKey = FlagManager.serializeScope(scope)
    const previous = await FlagManager.store().get(feature, scopeKey)
    await FlagManager.store().set(feature, scopeKey, false)
    FlagManager._cache.set(FlagManager.cacheKey(feature, scopeKey), false)
    await Emitter.emit('flag:updated', {
      feature,
      scope: scopeKey,
      value: false,
      previous,
      actor: actor ?? null,
    })
  }

  static async activateForEveryone(
    feature: string,
    value?: unknown,
    actor?: FlagActor | null
  ): Promise<void> {
    return FlagManager.activate(feature, value, null, actor)
  }

  static async deactivateForEveryone(
    feature: string,
    actor?: FlagActor | null
  ): Promise<void> {
    return FlagManager.deactivate(feature, null, actor)
  }

  // ── Batch operations ───────────────────────────────────────────────

  static async values(features: string[], scope?: Scopeable | null): Promise<Map<string, unknown>> {
    const result = new Map<string, unknown>()
    const scopeKey = FlagManager.serializeScope(scope)

    // Collect cache hits and misses
    const misses: string[] = []
    for (const f of features) {
      const ck = FlagManager.cacheKey(f, scopeKey)
      if (FlagManager._cache.has(ck)) {
        result.set(f, FlagManager._cache.get(ck))
      } else {
        misses.push(f)
      }
    }

    if (misses.length === 0) return result

    // Check store for remaining
    const stored = await FlagManager.store().getMany(misses, scopeKey)
    const stillMissing: string[] = []

    for (const f of misses) {
      if (stored.has(f)) {
        const val = stored.get(f)
        result.set(f, val)
        FlagManager._cache.set(FlagManager.cacheKey(f, scopeKey), val)
      } else {
        stillMissing.push(f)
      }
    }

    // Resolve any that aren't stored yet
    for (const f of stillMissing) {
      const val = await FlagManager.resolveFeature(f, scopeKey)
      await FlagManager.store().set(f, scopeKey, val)
      FlagManager._cache.set(FlagManager.cacheKey(f, scopeKey), val)
      result.set(f, val)
      await Emitter.emit('flag:resolved', { feature: f, scope: scopeKey, value: val })
    }

    return result
  }

  /** Get all stored feature names. */
  static async stored(): Promise<string[]> {
    return FlagManager.store().featureNames()
  }

  // ── Eager loading ──────────────────────────────────────────────────

  static async load(features: string[], scopes: Scopeable[]): Promise<void> {
    const store = FlagManager.store()

    for (const scope of scopes) {
      const scopeKey = FlagManager.serializeScope(scope)
      const stored = await store.getMany(features, scopeKey)

      for (const [f, val] of stored) {
        FlagManager._cache.set(FlagManager.cacheKey(f, scopeKey), val)
      }

      // Resolve any not yet stored
      for (const f of features) {
        if (!stored.has(f)) {
          const val = await FlagManager.resolveFeature(f, scopeKey)
          await store.set(f, scopeKey, val)
          FlagManager._cache.set(FlagManager.cacheKey(f, scopeKey), val)
        }
      }
    }
  }

  // ── Cleanup ────────────────────────────────────────────────────────

  static async forget(feature: string, scope?: Scopeable | null): Promise<void> {
    const scopeKey = FlagManager.serializeScope(scope)
    await FlagManager.store().forget(feature, scopeKey)
    FlagManager._cache.delete(FlagManager.cacheKey(feature, scopeKey))
    await Emitter.emit('flag:deleted', { feature, scope: scopeKey })
  }

  static async purge(feature: string): Promise<void> {
    await FlagManager.store().purge(feature)
    // Clear all cache entries for this feature
    for (const key of FlagManager._cache.keys()) {
      if (key.startsWith(`${feature}\0`)) FlagManager._cache.delete(key)
    }
    await Emitter.emit('flag:deleted', { feature, scope: '*' })
  }

  static async purgeAll(): Promise<void> {
    await FlagManager.store().purgeAll()
    FlagManager._cache.clear()
    await Emitter.emit('flag:deleted', { feature: '*', scope: '*' })
  }

  // ── Driver management ──────────────────────────────────────────────

  static store(name?: string): FeatureStore {
    const key = name ?? FlagManager.config.default

    let store = FlagManager._stores.get(key)
    if (store) return store

    const driverConfig = FlagManager.config.drivers[key]
    if (!driverConfig) {
      throw new ConfigurationError(`Flag driver "${key}" is not configured.`)
    }

    store = FlagManager.createStore(key, driverConfig)
    FlagManager._stores.set(key, store)
    return store
  }

  static extend(name: string, factory: (config: DriverConfig) => FeatureStore): void {
    FlagManager._extensions.set(name, factory)
  }

  // ── Cache ──────────────────────────────────────────────────────────

  static flushCache(): void {
    FlagManager._cache.clear()
  }

  // ── Table setup ────────────────────────────────────────────────────

  static async ensureTables(): Promise<void> {
    const store = FlagManager.store()
    if (store instanceof DatabaseDriver) {
      await store.ensureTable()
    }
  }

  // ── Reset ──────────────────────────────────────────────────────────

  static reset(): void {
    FlagManager._stores.clear()
    FlagManager._extensions.clear()
    FlagManager._definitions.clear()
    FlagManager._classFeatures.clear()
    FlagManager._cache.clear()
    FlagManager._config = undefined as any
    FlagManager._db = undefined as any
  }

  // ── Private helpers ────────────────────────────────────────────────

  private static cacheKey(feature: string, scope: ScopeKey): string {
    return `${feature}\0${scope}`
  }

  private static async resolveFeature(feature: string, scope: ScopeKey): Promise<unknown> {
    // Try closure definition first
    const resolver = FlagManager._definitions.get(feature)
    if (resolver) return resolver(scope)

    // Try class-based definition
    const Cls = FlagManager._classFeatures.get(feature)
    if (Cls) return new Cls().resolve(scope)

    throw new FeatureNotDefinedError(feature)
  }

  private static createStore(name: string, config: DriverConfig): FeatureStore {
    const driverName = config.driver ?? name

    const extension = FlagManager._extensions.get(driverName)
    if (extension) return extension(config)

    switch (driverName) {
      case 'database':
        return new DatabaseDriver(FlagManager._db.sql)
      case 'array':
        return new ArrayDriver()
      default:
        throw new ConfigurationError(
          `Unknown flag driver "${driverName}". Register it with FlagManager.extend().`
        )
    }
  }
}

function toKebab(name: string): string {
  return name
    .replace(/([a-z])([A-Z])/g, '$1-$2')
    .replace(/[\s_]+/g, '-')
    .toLowerCase()
}
