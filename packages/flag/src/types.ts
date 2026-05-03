// ── Scope ────────────────────────────────────────────────────────────────

/** Any object that can be used as a feature flag scope. */
export interface Scopeable {
  id: string | number
  /** Optional type discriminator. Defaults to constructor.name. */
  featureScope?: () => string
}

/** Serialized scope string, e.g. 'User:42', '__global__'. */
export type ScopeKey = string

/** The global scope sentinel. */
export const GLOBAL_SCOPE = '__global__'

// ── Feature definitions ──────────────────────────────────────────────────

/** A closure that resolves a feature value for the given scope. */
export type FeatureResolver<T = unknown> = (scope: ScopeKey) => T | Promise<T>

/** A class-based feature with a `resolve` method. */
export interface FeatureClass {
  readonly key?: string
  resolve(scope: ScopeKey): unknown | Promise<unknown>
}

export interface FeatureClassConstructor {
  key?: string
  new (): FeatureClass
}

// ── Stored values ────────────────────────────────────────────────────────

export interface StoredFeature {
  feature: string
  scope: ScopeKey
  value: unknown
  createdAt: Date
  updatedAt: Date
}

// ── Configuration ────────────────────────────────────────────────────────

export interface FlagConfig {
  default: string
  drivers: Record<string, DriverConfig>
}

export interface DriverConfig {
  driver: string
  [key: string]: unknown
}

// ── Actor ────────────────────────────────────────────────────────────────

/**
 * Who initiated a flag write. Optional, but recommended for accountability.
 * Carried through to `flag:updated` event payloads so an audit hook can
 * record the change. See `@strav/flag` CLAUDE.md for the recommended
 * audit-integration pattern.
 */
export interface FlagActor {
  type: string
  id: string | number
}

// ── Events ───────────────────────────────────────────────────────────────

/**
 * Payload for the `flag:updated` Emitter event. Fired when `activate()`
 * or `deactivate()` writes to the store.
 */
export interface FlagUpdatedEvent {
  feature: string
  scope: ScopeKey
  value: unknown
  /** Previous stored value (if any) — undefined when the flag had no prior store entry. */
  previous: unknown
  /** Who initiated the change. `null` when the caller did not provide an actor. */
  actor: FlagActor | null
}
