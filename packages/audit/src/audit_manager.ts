import { inject } from '@strav/kernel'
import { ConfigurationError, EncryptionManager } from '@strav/kernel'
import { Configuration } from '@strav/kernel'
import { Database } from '@strav/database'
import { DatabaseAuditDriver } from './drivers/database_driver.ts'
import { MemoryAuditDriver } from './drivers/memory_driver.ts'
import type { AuditConfig, AuditEvent, AuditStore } from './types.ts'

/**
 * Central audit log configuration hub.
 *
 * Resolved once via the DI container. Owns the active store and computes
 * the chain hash on every insert via {@link EncryptionManager.sign}.
 *
 * @example
 * app.singleton(AuditManager)
 * app.resolve(AuditManager)
 * await AuditManager.ensureTable()
 *
 * // Plug in a custom store
 * AuditManager.useStore(new MyCustomStore())
 */
@inject
export default class AuditManager {
  private static _store: AuditStore
  private static _config: AuditConfig

  constructor(config: Configuration) {
    AuditManager._config = {
      driver: config.get('audit.driver', 'database') as string,
      chain: config.get('audit.chain', true) as boolean,
    }
    AuditManager._store = AuditManager.createStore(AuditManager._config.driver)
  }

  private static createStore(driver: string): AuditStore {
    switch (driver) {
      case 'database':
        return new DatabaseAuditDriver(Database.raw)
      case 'memory':
        return new MemoryAuditDriver()
      default:
        throw new ConfigurationError(
          `Unknown audit driver: ${driver}. Use AuditManager.useStore() for custom stores.`
        )
    }
  }

  static get store(): AuditStore {
    if (!AuditManager._store) {
      throw new ConfigurationError(
        'AuditManager not configured. Resolve it through the container first.'
      )
    }
    return AuditManager._store
  }

  static get config(): AuditConfig {
    return AuditManager._config
  }

  static useStore(store: AuditStore): void {
    AuditManager._store = store
  }

  /** Create the audit log table (no-op for non-database stores). */
  static async ensureTable(): Promise<void> {
    await AuditManager.store.ensureTable()
  }

  /**
   * Append a new event to the chain, computing the HMAC over the previous
   * hash and the canonical event payload. Returns the persisted event with
   * `id`, `prevHash`, `hash`, and `createdAt` populated by the store.
   */
  static async append(event: AuditEvent): Promise<AuditEvent> {
    const prevHash = AuditManager._config.chain ? await AuditManager.store.lastHash() : null
    const enriched: AuditEvent = {
      ...event,
      prevHash,
      hash: AuditManager._config.chain ? hashFor(event, prevHash) : undefined,
    }
    return AuditManager.store.insert(enriched)
  }

  /** For testing only — clears the in-memory cache of the active store. */
  static reset(): void {
    if (AuditManager._store && 'reset' in AuditManager._store) {
      void AuditManager._store.reset()
    }
  }
}

/**
 * Canonical serialization of an event for HMAC computation. Tuple form
 * sidesteps key-ordering ambiguity that comes with stringifying objects.
 * Keep this exported — chain verification recomputes hashes the same way.
 */
export function canonicalize(event: AuditEvent, prevHash: string | null): string {
  return JSON.stringify([
    event.actorType ?? null,
    event.actorId ?? null,
    event.subjectType,
    event.subjectId,
    event.action,
    event.diff ?? null,
    event.metadata ?? null,
    prevHash,
  ])
}

/** Compute the HMAC for an event row. Used on insert and on integrity check. */
export function hashFor(event: AuditEvent, prevHash: string | null): string {
  return EncryptionManager.sign(canonicalize(event, prevHash))
}
