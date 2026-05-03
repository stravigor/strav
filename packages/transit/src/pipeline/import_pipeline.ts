import { Database } from '@strav/database'
import { DedupKeyLimitError, TooManyErrorsError } from '../errors.ts'
import { readCsv } from '../csv/reader.ts'
import { readJsonl } from '../jsonl/reader.ts'
import { ProgressReporter } from './progress.ts'
import type {
  CsvReadOptions,
  ImportResult,
  ProgressReport,
  ReadSource,
  RowError,
  UpsertTarget,
} from '../types.ts'

type RowMapper<I, O> = (row: I, index: number) => O | null | undefined
type RowValidator<T> = (row: T, index: number) => string | null | undefined | void
type RowSink<T> = (batch: T[]) => Promise<void> | void

/**
 * Fluent import pipeline. Reads from a CSV/JSONL source, runs each row
 * through user-supplied `map` / `validate` / `dedupBy` filters, and writes
 * to a destination via `upsertInto()` (database upsert) or `into()` (custom
 * batched handler).
 *
 * Pipeline order:
 * 1. read & decode (`from()` + `format()`)
 * 2. `map()` — type the row
 * 3. `validate()` — reject row with a reason
 * 4. `dedupBy()` — drop subsequent duplicates by key
 * 5. destination — `upsertInto()` (Postgres) or `into()` (callback)
 *
 * Counts on the result:
 * - `processed`: rows pulled from the source (regardless of fate)
 * - `inserted`: rows that produced a new destination record
 * - `updated`: rows that updated an existing destination record (upsertInto only)
 * - `skipped`: rows dropped by `validate` returning a reason, by dedup, or by
 *   `map` returning null/undefined
 * - `errors`: row-level errors (skipped rows that returned a reason are NOT errors —
 *   errors are unhandled exceptions raised inside map/validate/destination)
 *
 * When `maxErrors(n)` is set and the count is exceeded mid-import, the run
 * aborts with `TooManyErrorsError`. Otherwise the result includes every
 * accumulated `RowError`.
 */
export class PendingImport<I = Record<string, string>, O = I> {
  private _source?: ReadSource
  private _format: 'csv' | 'jsonl' = 'csv'
  private _csvOpts: CsvReadOptions = {}
  private _mappers: ((row: any, index: number) => any)[] = []
  private _validators: ((row: any, index: number) => string | null | undefined | void)[] = []
  private _dedupKey?: string | ((row: any) => unknown)
  private _seen = new Set<string>()
  private _maxDedupKeys = 1_000_000
  private _upsertTarget?: UpsertTarget
  private _customSink?: RowSink<any>
  private _batchSize = 500
  private _onProgress?: (r: ProgressReport) => void | Promise<void>
  private _maxErrors = Infinity

  constructor(format: 'csv' | 'jsonl' = 'csv') {
    this._format = format
  }

  from(source: ReadSource): this {
    this._source = source
    return this
  }

  /** CSV-specific: override delimiter / quote / header. No-op for JSONL. */
  csvOptions(opts: CsvReadOptions): this {
    this._csvOpts = { ...this._csvOpts, ...opts }
    return this
  }

  header(columns: string[]): this {
    this._csvOpts.header = columns
    return this
  }

  map<N>(fn: RowMapper<O, N>): PendingImport<I, N> {
    this._mappers.push(fn)
    return this as unknown as PendingImport<I, N>
  }

  validate(fn: RowValidator<O>): this {
    this._validators.push(fn)
    return this
  }

  /**
   * Drop subsequent rows with the same key. Key is a column name or
   * extractor function.
   *
   * The dedup `Set` grows for every distinct key seen, so this is
   * unsafe for adversarial / unbounded sources. The pipeline aborts
   * with `Error('dedupBy exceeded maxDedupKeys (...)')` when the set
   * crosses the configured ceiling — see `maxDedupKeys()`. For data
   * sets where uniqueness is genuinely unbounded, prefer DB-native
   * deduplication (UNIQUE index + `upsertInto`, or
   * `SELECT DISTINCT ON`).
   */
  dedupBy(key: keyof O & string): this
  dedupBy(extractor: (row: O) => unknown): this
  dedupBy(arg: string | ((row: O) => unknown)): this {
    this._dedupKey = arg as string | ((row: any) => unknown)
    return this
  }

  /**
   * Cap on the number of distinct dedup keys held in memory. Default:
   * 1,000,000 (≈100 MB at 100 bytes per key). When the cap is exceeded,
   * the pipeline aborts the run with a clear error so callers don't
   * silently OOM on adversarial input. Pass `Infinity` to opt out
   * (unbounded — explicit acknowledgement of the trade-off).
   */
  maxDedupKeys(max: number): this {
    if (!Number.isFinite(max) && max !== Infinity) {
      throw new Error('maxDedupKeys must be a finite number or Infinity')
    }
    if (max <= 0) {
      throw new Error('maxDedupKeys must be positive')
    }
    this._maxDedupKeys = max
    return this
  }

  /**
   * Destination: PostgreSQL upsert via `INSERT … ON CONFLICT … DO UPDATE`.
   * Requires a UNIQUE index on the conflict column(s). Auto-detects column
   * order from the first observed row.
   */
  upsertInto(target: UpsertTarget): this {
    this._upsertTarget = target
    if (target.batchSize) this._batchSize = target.batchSize
    return this
  }

  /** Destination: a custom batched callback. Mutually exclusive with `upsertInto`. */
  into(handler: RowSink<O>): this {
    this._customSink = handler as RowSink<any>
    return this
  }

  onProgress(listener: (r: ProgressReport) => void | Promise<void>): this {
    this._onProgress = listener
    return this
  }

  maxErrors(n: number): this {
    this._maxErrors = n
    return this
  }

  batch(size: number): this {
    this._batchSize = size
    return this
  }

  async run(): Promise<ImportResult> {
    if (!this._source) throw new Error('transit.import: .from(source) is required')
    if (!this._upsertTarget && !this._customSink) {
      throw new Error('transit.import: call .upsertInto(...) or .into(...)')
    }

    // T-2: warn (once per run) when no validators are registered. Catches
    // the common bug of running an import without any row-level checks
    // and silently writing every malformed row. Apps that genuinely
    // want unvalidated imports can suppress this with a no-op
    // `.validate(() => null)`.
    if (this._validators.length === 0) {
      console.warn(
        '[transit.import] running with no validators registered — every row will be written unchecked. ' +
          "Add `.validate(row => …)` calls or pass `.validate(() => null)` to suppress this warning."
      )
    }

    // T-3: when upsertInto is configured, confirm a UNIQUE / PK
    // constraint covers the conflict columns. Without one, ON CONFLICT
    // silently degrades to plain INSERT and duplicates rows. The check
    // queries pg_indexes through the Database singleton, so it only
    // works against postgres — fail-soft for other backends.
    if (this._upsertTarget) {
      await assertConflictIndex(this._upsertTarget)
    }

    const reporter = new ProgressReporter()
    if (this._onProgress) reporter.on(this._onProgress)
    const errors: RowError[] = []
    let buffer: any[] = []
    let i = 0

    const rows = this.readRows()
    const flush = async () => {
      if (buffer.length === 0) return
      try {
        if (this._upsertTarget) {
          const { inserted, updated } = await upsertBatch(buffer, this._upsertTarget)
          for (let n = 0; n < inserted; n++) reporter.recordInserted()
          for (let n = 0; n < updated; n++) reporter.recordUpdated()
        } else if (this._customSink) {
          await this._customSink(buffer)
          for (let n = 0; n < buffer.length; n++) reporter.recordInserted()
        }
      } catch (err) {
        for (const row of buffer) {
          errors.push({ row: 0, reason: (err as Error).message, data: row })
          reporter.recordError()
        }
      }
      buffer = []
    }

    for await (const raw of rows) {
      i++
      let mapped: any = raw
      try {
        for (const fn of this._mappers) {
          mapped = fn(mapped, i)
          if (mapped === null || mapped === undefined) break
        }
        if (mapped === null || mapped === undefined) {
          reporter.recordSkipped()
          continue
        }
        let invalid: string | null | undefined | void
        for (const v of this._validators) {
          invalid = v(mapped, i)
          if (invalid) break
        }
        if (invalid) {
          errors.push({ row: i, reason: invalid, data: mapped })
          reporter.recordError()
          if (errors.length > this._maxErrors) throw new TooManyErrorsError(this._maxErrors)
          continue
        }
        if (this._dedupKey) {
          const key = String(
            typeof this._dedupKey === 'function'
              ? this._dedupKey(mapped)
              : (mapped as Record<string, unknown>)[this._dedupKey]
          )
          if (this._seen.has(key)) {
            reporter.recordSkipped()
            continue
          }
          if (this._seen.size >= this._maxDedupKeys) {
            // Memory safeguard: the dedup Set is unbounded by design,
            // but a malicious / very large source can exhaust RAM. Fail
            // loudly rather than silently OOM. Callers who genuinely
            // need unbounded dedup must opt in via `maxDedupKeys(Infinity)`.
            // The dedicated error class is re-thrown by the catch
            // block below rather than being swallowed into row errors.
            throw new DedupKeyLimitError(this._maxDedupKeys)
          }
          this._seen.add(key)
        }
        buffer.push(mapped)
        if (buffer.length >= this._batchSize) await flush()
      } catch (err) {
        if (err instanceof TooManyErrorsError) throw err
        if (err instanceof DedupKeyLimitError) throw err
        errors.push({ row: i, reason: (err as Error).message, data: raw })
        reporter.recordError()
        if (errors.length > this._maxErrors) throw new TooManyErrorsError(this._maxErrors)
      }
    }

    await flush()
    await reporter.finish()

    const snap = reporter.snapshot(true)
    return {
      processed: snap.processed,
      inserted: snap.inserted,
      updated: snap.updated,
      skipped: snap.skipped,
      errors,
    }
  }

  private async *readRows(): AsyncIterable<any> {
    const source = this._source!
    if (this._format === 'jsonl') {
      yield* readJsonl(source)
      return
    }
    yield* readCsv(source, this._csvOpts)
  }
}

/**
 * Confirm a UNIQUE / PK constraint covers exactly the conflict columns.
 * Without one, `INSERT ... ON CONFLICT (col) DO UPDATE` silently
 * degrades to plain INSERT and the import duplicates rows on every
 * re-run — exactly the kind of bug that's costly to discover later.
 *
 * Queries `pg_indexes.indexdef` and matches the `(col1, col2, ...)`
 * column list out of the raw definition. This is enough for the common
 * forms (`UNIQUE INDEX … ON tbl (col)` / `PRIMARY KEY (col, col2)`).
 */
async function assertConflictIndex(target: UpsertTarget): Promise<void> {
  const sql = Database.raw
  const conflictCols = Array.isArray(target.conflict) ? target.conflict : [target.conflict]
  const wanted = conflictCols.map(c => c.trim()).join(',')

  type IndexRow = { indexdef: string }
  const indexes = (await sql`
    SELECT indexdef FROM pg_indexes WHERE tablename = ${target.table}
  `) as IndexRow[]

  for (const row of indexes) {
    const def = row.indexdef
    // Only consider UNIQUE indexes / primary keys.
    if (!/UNIQUE/i.test(def) && !/PRIMARY KEY/i.test(def)) continue
    const match = def.match(/\(([^)]+)\)/)
    if (!match) continue
    const cols = match[1]!
      .split(',')
      .map(c => c.trim().replace(/^"(.*)"$/, '$1'))
      .join(',')
    if (cols === wanted) return
  }

  throw new Error(
    `transit.upsertInto: no UNIQUE or PRIMARY KEY index on ` +
      `${target.table}(${conflictCols.join(', ')}). ON CONFLICT requires one ` +
      `or every row will silently INSERT (and duplicate on re-run). Create ` +
      `the index first, e.g. \`CREATE UNIQUE INDEX ... ON "${target.table}" (${conflictCols
        .map(c => `"${c}"`)
        .join(', ')});\``
  )
}

async function upsertBatch(
  rows: Record<string, unknown>[],
  target: UpsertTarget
): Promise<{ inserted: number; updated: number }> {
  if (rows.length === 0) return { inserted: 0, updated: 0 }
  const sql = Database.raw
  const columns = Object.keys(rows[0]!)
  const conflictCols = Array.isArray(target.conflict) ? target.conflict : [target.conflict]
  const updateCols = (target.updateColumns ?? columns.filter(c => !conflictCols.includes(c)))

  // Build a single multi-VALUES INSERT … ON CONFLICT statement. Use the bun
  // SQL `${sql(rows, columns)}` form which expands a Record list into a
  // VALUES clause.
  const setClause = updateCols.length === 0
    ? sql`"${sql.unsafe(conflictCols[0]!)}" = EXCLUDED."${sql.unsafe(conflictCols[0]!)}"`
    : updateCols.reduce<unknown>((acc, col, idx) => {
        const expr = sql`"${sql.unsafe(col)}" = EXCLUDED."${sql.unsafe(col)}"`
        return idx === 0 ? expr : sql`${acc}, ${expr}`
      }, sql``)

  const conflictTarget = conflictCols.map(c => `"${c}"`).join(', ')

  const result = await sql`
    INSERT INTO ${sql.unsafe(`"${target.table}"`)} ${sql(rows, ...columns)}
    ON CONFLICT (${sql.unsafe(conflictTarget)}) DO UPDATE SET ${setClause}
    RETURNING (xmax = 0) AS inserted
  `
  let inserted = 0
  let updated = 0
  for (const row of result as Array<Record<string, unknown>>) {
    if (row.inserted) inserted++
    else updated++
  }
  return { inserted, updated }
}
