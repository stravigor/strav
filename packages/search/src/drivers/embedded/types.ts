import type { DriverConfig } from '../../types.ts'

export type TypoToleranceMode = 'off' | 'auto'

export interface TypoToleranceSettings {
  /** Minimum token length to consider for fuzzy expansion (default 4). */
  minTokenLength?: number
  /** Maximum Levenshtein distance to tolerate (default 1; 2 is supported but slower). */
  maxDistance?: number
}

export interface EmbeddedConfig extends DriverConfig {
  driver: string
  /** Directory holding the per-index `.sqlite` files. Use `:memory:` for tests. */
  path?: string
  /** SQLite synchronous pragma. Default 'NORMAL' (crash-safe, sub-second write loss possible). */
  synchronous?: 'OFF' | 'NORMAL' | 'FULL'
  /** Typo tolerance: 'off' disables; 'auto' uses defaults; object for fine-grained control. */
  typoTolerance?: TypoToleranceMode | TypoToleranceSettings
}

/** Resolved typo tolerance settings (after defaults applied). */
export interface ResolvedTypoTolerance {
  enabled: boolean
  minTokenLength: number
  maxDistance: number
}

/** Internal row shape from the documents table. */
export interface DocumentRow {
  rowid: number
  id: string
  doc: string
}
