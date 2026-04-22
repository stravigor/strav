import type { SQL } from 'bun'
import type { SearchEngine } from '../../search_engine.ts'
import type {
  SearchDocument,
  SearchOptions,
  SearchResult,
  IndexSettings,
  DriverConfig,
} from '../../types.ts'
import { PgEngine } from './engine/pg_engine.ts'
import { ensureSchemaAndExtensions } from './engine/schema.ts'
import { resolveTypoTolerance } from './engine/typo_expander.ts'
import type { PostgresFtsConfig, PgIndexSettings, ResolvedTypoTolerance } from './types.ts'
import { MissingConnectionError } from './errors.ts'

const DEFAULT_SCHEMA = 'strav_search'
const DEFAULT_LANGUAGE = 'english'
const DEFAULT_WORK_MEM = '64MB'

/**
 * Postgres-backed full-text search driver. Implements the same `SearchEngine`
 * interface as the embedded SQLite driver — drop-in swap by config.
 *
 * Sized for higher-volume workloads (1M-100M docs per index) using `tsvector`
 * + GIN + `pg_trgm` for typo tolerance + `ts_headline` for snippets.
 *
 * Connection: pass `connection` (a Bun `SQL` instance) in the driver config,
 * or rely on `Database.raw` from `@strav/database` (must be bootstrapped).
 */
export class PostgresFtsDriver implements SearchEngine {
  readonly name = 'postgres-fts'

  private readonly config: PostgresFtsConfig
  private readonly schemaName: string
  private readonly defaultLanguage: string
  private readonly typo: ResolvedTypoTolerance
  private readonly ginFastUpdate: boolean
  private readonly workMem: string | null
  private readonly engines = new Map<string, PgEngine>()
  private readonly pendingSettings = new Map<string, PgIndexSettings>()
  private bootstrapped: Promise<void> | null = null
  private resolvedSql: SQL | null = null

  constructor(config: DriverConfig) {
    this.config = (config ?? {}) as PostgresFtsConfig
    this.schemaName = this.config.schema ?? DEFAULT_SCHEMA
    this.defaultLanguage = this.config.language ?? DEFAULT_LANGUAGE
    this.typo = resolveTypoTolerance(this.config.typoTolerance)
    this.ginFastUpdate = this.config.gin?.fastupdate ?? false
    this.workMem =
      this.config.workMem === null
        ? null
        : (this.config.workMem ?? DEFAULT_WORK_MEM)
  }

  // ── Document operations ──────────────────────────────────────────────────

  async upsert(
    index: string,
    id: string | number,
    document: Record<string, unknown>
  ): Promise<void> {
    await (await this.engineFor(index)).upsert(id, document)
  }

  async upsertMany(index: string, documents: SearchDocument[]): Promise<void> {
    await (await this.engineFor(index)).upsertMany(documents)
  }

  async delete(index: string, id: string | number): Promise<void> {
    await (await this.engineFor(index)).delete(id)
  }

  async deleteMany(index: string, ids: Array<string | number>): Promise<void> {
    await (await this.engineFor(index)).deleteMany(ids)
  }

  // ── Index operations ─────────────────────────────────────────────────────

  async flush(index: string): Promise<void> {
    await (await this.engineFor(index)).flush()
  }

  async deleteIndex(index: string): Promise<void> {
    const engine = this.engines.get(index)
    if (engine) {
      await engine.drop()
      this.engines.delete(index)
    } else {
      // Drop directly without instantiating an engine.
      const sql = this.resolveSql()
      const { dropIndex } = await import('./engine/schema.ts')
      await dropIndex(sql, this.schemaName, index)
    }
    this.pendingSettings.delete(index)
  }

  async createIndex(index: string, options?: IndexSettings): Promise<void> {
    if (options) this.pendingSettings.set(index, options as PgIndexSettings)
    const engine = await this.engineFor(index)
    await engine.ensure()
  }

  // ── Search ───────────────────────────────────────────────────────────────

  async search(index: string, query: string, options?: SearchOptions): Promise<SearchResult> {
    return (await this.engineFor(index)).search(query, options)
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /** Run REINDEX on every open index, or just one if specified. */
  async optimize(index?: string): Promise<void> {
    if (index) {
      await (await this.engineFor(index)).optimize()
      return
    }
    for (const engine of this.engines.values()) await engine.optimize()
  }

  /**
   * Rebuild a single index's `fts` column in place. Use after changing
   * `searchableAttributes` or weights — without it, existing rows keep the
   * old fts values.
   */
  async rebuild(
    index: string,
    options?: { reindex?: boolean; pauseMs?: number; onProgress?: (done: number, total: number) => void }
  ): Promise<{ tier: 1 | 2; rows: number; elapsedMs: number }> {
    return (await this.engineFor(index)).rebuild(options)
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async engineFor(index: string): Promise<PgEngine> {
    let engine = this.engines.get(index)
    if (engine) return engine

    await this.bootstrap()
    const settings = this.pendingSettings.get(index)
    engine = new PgEngine({
      sql: this.resolveSql(),
      schema: this.schemaName,
      index,
      language: settings?.language ?? this.defaultLanguage,
      typoTolerance: this.typo,
      ginFastUpdate: this.ginFastUpdate,
      workMem: this.workMem,
      settings,
    })
    this.engines.set(index, engine)
    this.pendingSettings.delete(index)
    return engine
  }

  /** Resolve the SQL connection (config.connection or Database.raw fallback). */
  private resolveSql(): SQL {
    if (this.resolvedSql) return this.resolvedSql
    if (this.config.connection) {
      this.resolvedSql = this.config.connection
      return this.resolvedSql
    }
    try {
      // Lazy require to avoid a hard dep at import time.
      const databaseModule = require('@strav/database')
      const Database = databaseModule.default ?? databaseModule.Database
      this.resolvedSql = Database.raw as SQL
      return this.resolvedSql
    } catch {
      throw new MissingConnectionError()
    }
  }

  /** Idempotent: ensure schema + extensions exist, once per driver. */
  private bootstrap(): Promise<void> {
    if (this.bootstrapped) return this.bootstrapped
    this.bootstrapped = ensureSchemaAndExtensions(
      this.resolveSql(),
      this.schemaName,
      this.typo
    )
    return this.bootstrapped
  }
}
