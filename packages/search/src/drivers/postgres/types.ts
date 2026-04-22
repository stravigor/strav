import type { SQL } from 'bun'
import type { DriverConfig, IndexSettings } from '../../types.ts'

export type TypoToleranceMode = 'off' | 'auto'

export interface TypoToleranceSettings {
  /** Minimum token length to consider for fuzzy expansion (default 4). */
  minTokenLength?: number
  /** Maximum Levenshtein distance to tolerate (default 1; 2 is supported but slower). */
  maxDistance?: number
  /** pg_trgm similarity threshold (default 0.4). Higher = stricter. */
  similarity?: number
}

export interface PostgresFtsConfig extends DriverConfig {
  driver: string
  /**
   * Bun SQL connection. If omitted, the driver falls back to
   * `Database.raw` from `@strav/database` (must be bootstrapped first).
   */
  connection?: SQL
  /** Postgres schema for index tables. Default 'strav_search'. */
  schema?: string
  /** Default text-search configuration ('english', 'french', ...). */
  language?: string
  /** Typo tolerance: 'off' disables; 'auto' uses defaults; object for fine-grained control. */
  typoTolerance?: TypoToleranceMode | TypoToleranceSettings
  /** GIN index tuning. */
  gin?: {
    /** Default false — better tail latency for read-heavy search. */
    fastupdate?: boolean
  }
  /** Per-search-transaction work_mem hint, e.g. '64MB'. Set to null/empty to skip. */
  workMem?: string | null
}

/** Resolved typo tolerance settings (after defaults applied). */
export interface ResolvedTypoTolerance {
  enabled: boolean
  minTokenLength: number
  maxDistance: number
  similarity: number
}

/** Per-index extra settings stored in `_meta`. */
export interface PgIndexSettings extends IndexSettings {
  language?: string
  /**
   * Per-attribute weight tier override. Keys must appear in `searchableAttributes`.
   * Values: 'A' | 'B' | 'C' | 'D'. Default = positional (1st=A, 2nd=B, ...).
   */
  weights?: Record<string, 'A' | 'B' | 'C' | 'D'>
}
