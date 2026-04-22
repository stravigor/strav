import type { SearchEngine } from '../../search_engine.ts'
import type {
  SearchDocument,
  SearchOptions,
  SearchResult,
  IndexSettings,
  DriverConfig,
} from '../../types.ts'
import { SqliteEngine } from './engine/sqlite_engine.ts'
import { resolveTypoTolerance } from './engine/typo_expander.ts'
import { resolveIndexPath, MEMORY_PATH } from './storage/paths.ts'
import type { EmbeddedConfig, ResolvedTypoTolerance } from './types.ts'

/**
 * In-process full-text search driver backed by SQLite FTS5.
 *
 * Each index lives in its own SQLite file (or `:memory:` for tests). The
 * driver maintains a `Map<indexName, SqliteEngine>` and creates engines
 * lazily on first reference. This means a fresh `upsert()` against a
 * never-created index will auto-create a default schema (single `_text`
 * column). Callers that want per-field weights call `createIndex()` first
 * with their `IndexSettings`.
 */
export class EmbeddedDriver implements SearchEngine {
  readonly name = 'embedded'

  private readonly config: EmbeddedConfig
  private readonly synchronous: 'OFF' | 'NORMAL' | 'FULL'
  private readonly typo: ResolvedTypoTolerance
  private readonly engines = new Map<string, SqliteEngine>()
  /** Pending settings for indexes that haven't been opened yet. */
  private readonly pendingSettings = new Map<string, IndexSettings>()

  constructor(config: DriverConfig) {
    this.config = (config ?? {}) as EmbeddedConfig
    this.synchronous = this.config.synchronous ?? 'NORMAL'
    this.typo = resolveTypoTolerance(this.config.typoTolerance)
  }

  // ── Document operations ──────────────────────────────────────────────────

  async upsert(
    index: string,
    id: string | number,
    document: Record<string, unknown>
  ): Promise<void> {
    this.engineFor(index).upsert(id, document)
  }

  async upsertMany(index: string, documents: SearchDocument[]): Promise<void> {
    this.engineFor(index).upsertMany(documents)
  }

  async delete(index: string, id: string | number): Promise<void> {
    this.engineFor(index).delete(id)
  }

  async deleteMany(index: string, ids: Array<string | number>): Promise<void> {
    this.engineFor(index).deleteMany(ids)
  }

  // ── Index operations ─────────────────────────────────────────────────────

  async flush(index: string): Promise<void> {
    this.engineFor(index).flush()
  }

  async deleteIndex(index: string): Promise<void> {
    const engine = this.engines.get(index)
    if (engine) {
      engine.close()
      this.engines.delete(index)
    }
    this.pendingSettings.delete(index)

    const path = resolveIndexPath(this.config, index)
    if (path === MEMORY_PATH) return

    const fs = await import('node:fs/promises')
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        await fs.unlink(`${path}${suffix}`)
      } catch (err: any) {
        if (err?.code !== 'ENOENT') throw err
      }
    }
  }

  async createIndex(index: string, options?: IndexSettings): Promise<void> {
    if (options) this.pendingSettings.set(index, options)
    // Force engine instantiation so the schema exists on disk.
    this.engineFor(index)
  }

  // ── Search ───────────────────────────────────────────────────────────────

  async search(index: string, query: string, options?: SearchOptions): Promise<SearchResult> {
    return this.engineFor(index).search(query, options)
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /** Close all open engines. Call from app shutdown. */
  close(): void {
    for (const engine of this.engines.values()) engine.close()
    this.engines.clear()
  }

  /** Run FTS5 segment merge on every open index. Use from CLI for periodic ops. */
  optimize(index?: string): void {
    if (index) {
      this.engineFor(index).optimize()
      return
    }
    for (const engine of this.engines.values()) engine.optimize()
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private engineFor(index: string): SqliteEngine {
    let engine = this.engines.get(index)
    if (engine) return engine

    const settings = this.pendingSettings.get(index)
    engine = new SqliteEngine({
      path: resolveIndexPath(this.config, index),
      synchronous: this.synchronous,
      typoTolerance: this.typo,
      indexName: index,
      settings,
    })
    this.engines.set(index, engine)
    this.pendingSettings.delete(index)
    return engine
  }
}
