/** Source for a CSV/JSONL reader. Strings, byte arrays, and any async byte/string source are accepted. */
export type ReadSource =
  | string
  | Uint8Array
  | ReadableStream<Uint8Array>
  | AsyncIterable<Uint8Array | string>

/** Destination for a writer — anything that exposes a writer or a write callback. */
export type WriteSink =
  | WritableStream<Uint8Array | string>
  | { write(chunk: string): void | Promise<void>; close?(): void | Promise<void> }

export interface CsvReadOptions {
  /** Field delimiter. Default: `,` */
  delimiter?: string
  /** Quote character. Default: `"` */
  quote?: string
  /**
   * - `true` (default): use the first row as header → emit `Record<string, string>`.
   * - `false`: emit `string[]` rows, no header.
   * - `string[]`: use the supplied names as headers (the first row is data).
   */
  header?: boolean | string[]
  /** Skip rows that are empty (no fields or all-empty fields). Default: `true` */
  skipEmpty?: boolean
}

export interface CsvWriteOptions {
  delimiter?: string
  quote?: string
  /** Line ending. Default: `\n` */
  newline?: string
  /** Override column order; otherwise inferred from the first row's keys. */
  columns?: string[]
  /** Whether to write the header row. Default: `true` when columns are inferred, `true` for explicit columns. */
  writeHeader?: boolean
}

/** Represents a row that failed validation, dedup, or destination write. */
export interface RowError {
  row: number
  reason: string
  data?: unknown
}

/** Snapshot of an in-progress import. */
export interface ProgressReport {
  processed: number
  inserted: number
  updated: number
  skipped: number
  errors: number
  /** True once the input source has been fully consumed. */
  done: boolean
}

export interface ImportResult {
  processed: number
  inserted: number
  updated: number
  skipped: number
  errors: RowError[]
}

/** Configuration for the upsert destination. */
export interface UpsertTarget {
  /** Target table name (PostgreSQL). */
  table: string
  /**
   * Conflict column(s). The first encounter wins; subsequent rows with the
   * same dedup key UPDATE that row. Use a column with a UNIQUE index on it.
   */
  conflict: string | string[]
  /**
   * Columns to update on conflict. Defaults to all non-conflict columns from
   * the first observed row.
   */
  updateColumns?: string[]
  /** Batch size for INSERT statements. Default: 500. */
  batchSize?: number
}
