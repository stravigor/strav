import type { SQL } from 'bun'
import type {
  SearchDocument,
  SearchOptions,
  SearchResult,
  SearchHit,
} from '../../../types.ts'
import type { PgIndexSettings, ResolvedTypoTolerance } from '../types.ts'
import { FieldRegistry } from './field_registry.ts'
import { ensureIndexTable, dropIndex as dropIndexSchema } from './schema.ts'
import { parseQuery, buildTsqueryExpression } from './fts_query_builder.ts'
import { compileSearch } from './query_compiler.ts'
import { formatSnippet } from './snippet_formatter.ts'
import {
  expandTokens,
  hasFuzzystrmatch,
  recordTerms,
  unrecordTerms,
} from './typo_expander.ts'
import {
  indexTableName,
  termsTableName,
  quoteIdent,
  quoteLiteral,
} from '../storage/identifiers.ts'
import { rebuildInPlace, type RebuildOptions } from '../rebuild/rebuild_inplace.ts'

export interface PgEngineOptions {
  sql: SQL
  schema: string
  index: string
  language: string
  typoTolerance: ResolvedTypoTolerance
  ginFastUpdate: boolean
  workMem: string | null
  settings?: PgIndexSettings
}

/** Postgres tsvector silently truncates at ~1MB lexemes. Truncate inputs to be safe. */
const MAX_TEXT_BYTES = 900_000

/** One PgEngine wraps a single index. */
export class PgEngine {
  readonly registry: FieldRegistry
  private readonly sql: SQL
  private readonly schema: string
  private readonly index: string
  private readonly typo: ResolvedTypoTolerance
  private readonly ginFastUpdate: boolean
  private readonly workMem: string | null
  private readonly tableName: string
  private fuzzyAvailable: boolean | null = null
  private ensured = false

  constructor(opts: PgEngineOptions) {
    this.sql = opts.sql
    this.schema = opts.schema
    this.index = opts.index
    this.typo = opts.typoTolerance
    this.ginFastUpdate = opts.ginFastUpdate
    this.workMem = opts.workMem
    this.registry = new FieldRegistry(opts.settings, opts.language)
    this.tableName = indexTableName(opts.schema, opts.index)
  }

  /** Lazy: ensure the table + indexes + trigger exist. Idempotent. */
  async ensure(): Promise<void> {
    if (this.ensured) return
    await ensureIndexTable(this.sql, this.schema, this.index, this.registry, this.ginFastUpdate)
    if (this.typo.enabled && this.fuzzyAvailable === null) {
      this.fuzzyAvailable = await hasFuzzystrmatch(this.sql)
    }
    this.ensured = true
  }

  // ── Writes ──────────────────────────────────────────────────────────────

  async upsert(id: string | number, document: Record<string, unknown>): Promise<void> {
    await this.upsertMany([{ id, ...document }])
  }

  async upsertMany(documents: SearchDocument[]): Promise<void> {
    if (documents.length === 0) return
    await this.ensure()

    await this.sql.begin(async (tx: SQL) => {
      for (const raw of documents) {
        const { id, ...rest } = raw
        const idStr = String(id)
        // Bun's SQL treats stringified JSON as a JSONB string value (double-
        // encoding the JSON). Passing the object directly lets it generate
        // proper JSONB so `doc->>'field'` works for the typed generated cols.
        const doc = { id, ...(rest as Record<string, unknown>) }
        const newText = truncate(this.registry.concatSearchableText(rest as Record<string, unknown>))

        const oldRows = (await tx.unsafe(
          `SELECT doc FROM ${this.tableName} WHERE id = $1`,
          [idStr]
        )) as Array<{ doc: Record<string, unknown> | string }>
        if (oldRows.length > 0) {
          const oldDoc = parseDoc(oldRows[0]!.doc)
          const oldText = this.registry.concatSearchableText(oldDoc)
          if (this.typo.enabled) await unrecordTerms(tx, this.schema, this.index, oldText)
        }

        const ftsExpr = this.buildFtsExpression(rest as Record<string, unknown>)
        const sqlStr =
          `INSERT INTO ${this.tableName} (id, doc, fts) VALUES ($1, $2, ${ftsExpr.sql}) ` +
          `ON CONFLICT (id) DO UPDATE SET doc = EXCLUDED.doc, fts = EXCLUDED.fts`
        await tx.unsafe(sqlStr, [idStr, doc as any, ...ftsExpr.params])

        if (this.typo.enabled) await recordTerms(tx, this.schema, this.index, newText)
      }
    })
  }

  async delete(id: string | number): Promise<void> {
    await this.deleteMany([id])
  }

  async deleteMany(ids: Array<string | number>): Promise<void> {
    if (ids.length === 0) return
    await this.ensure()

    await this.sql.begin(async (tx: SQL) => {
      const idStrs = ids.map(String)
      const placeholders = idStrs.map((_, i) => `$${i + 1}`).join(', ')

      if (this.typo.enabled) {
        const rows = (await tx.unsafe(
          `SELECT doc FROM ${this.tableName} WHERE id IN (${placeholders})`,
          idStrs
        )) as Array<{ doc: Record<string, unknown> | string }>
        for (const r of rows) {
          const oldDoc = parseDoc(r.doc)
          await unrecordTerms(tx, this.schema, this.index, this.registry.concatSearchableText(oldDoc))
        }
      }

      await tx.unsafe(
        `DELETE FROM ${this.tableName} WHERE id IN (${placeholders})`,
        idStrs
      )
    })
  }

  async flush(): Promise<void> {
    await this.ensure()
    await this.sql.begin(async (tx: SQL) => {
      await tx.unsafe(`TRUNCATE ${this.tableName}`)
      if (this.typo.enabled) {
        await tx.unsafe(`TRUNCATE ${termsTableName(this.schema, this.index)}`)
      }
    })
  }

  async drop(): Promise<void> {
    await dropIndexSchema(this.sql, this.schema, this.index)
    this.ensured = false
  }

  // ── Reads ───────────────────────────────────────────────────────────────

  async search(query: string, options?: SearchOptions): Promise<SearchResult> {
    await this.ensure()
    const start = performance.now()
    const opts = options ?? {}
    const parsed = parseQuery(query)

    const expansions = await this.maybeExpand(parsed.positiveTokens)
    const tsquery = buildTsqueryExpression(parsed, expansions, this.registry.language)

    const compiled = compileSearch({
      registry: this.registry,
      schema: this.schema,
      index: this.index,
      tsquery: { sql: tsquery.sql, params: tsquery.params },
      search: opts,
    })

    const result = await this.sql.begin(async (tx: SQL) => {
      if (this.workMem) {
        await tx.unsafe(`SET LOCAL work_mem = ${quoteLiteral(this.workMem)}`)
      }
      const rows = (await tx.unsafe(compiled.sql, compiled.params)) as RawHitRow[]
      const totalRows = (await tx.unsafe(compiled.countSql, compiled.countParams)) as Array<{
        n: number
      }>
      return { rows, total: totalRows[0]?.n ?? rows.length }
    })

    const projection = opts.attributesToRetrieve
    const hits: SearchHit[] = result.rows.map(row =>
      projectHit(row, compiled.snippetColumns, projection)
    )

    return {
      hits,
      totalHits: result.total,
      page: Math.max(1, opts.page ?? 1),
      perPage: Math.max(1, opts.perPage ?? 20),
      processingTimeMs: Math.round(performance.now() - start),
    }
  }

  /** REINDEX the GIN index. Periodic maintenance for write-heavy indexes. */
  async optimize(): Promise<void> {
    await this.ensure()
    const ginName = `${quoteIdent(this.schema)}.${quoteIdent(`search_${this.index}_fts_gin`)}`
    await this.sql.unsafe(`REINDEX INDEX ${ginName}`)
  }

  /**
   * Recompute every row's `fts` using the current registry's language + weight
   * scheme. Auto-picks tier (in-place vs batched) by row count; throws on
   * tables larger than the supported tier-2 ceiling.
   */
  async rebuild(options?: RebuildOptions) {
    await this.ensure()
    return rebuildInPlace(this.sql, this.schema, this.index, this.registry, options)
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private buildFtsExpression(document: Record<string, unknown>): {
    sql: string
    params: string[]
  } {
    const segments = this.registry.projectFtsSegments(document)
    const lang = `${quoteLiteral(this.registry.language)}::regconfig`
    const params: string[] = []
    const fragments = segments.map(seg => {
      params.push(truncate(seg.text))
      return `setweight(to_tsvector(${lang}, $${params.length + 2}), '${seg.tier}')`
    })
    // The `+2` above accounts for the leading id ($1) and doc ($2) bindings
    // that callers prepend. Caller MUST keep those positions stable.
    return { sql: fragments.join(' || '), params }
  }

  private async maybeExpand(tokens: string[]): Promise<Map<string, string[]>> {
    if (!this.typo.enabled || tokens.length === 0) return new Map()
    return expandTokens(
      this.sql,
      this.schema,
      this.index,
      tokens,
      this.typo,
      this.fuzzyAvailable === true
    )
  }
}

interface RawHitRow {
  id: string
  doc: Record<string, unknown> | string
  score: number
  [snippetCol: string]: unknown
}

function projectHit(
  row: RawHitRow,
  snippetCols: string[],
  attributesToRetrieve: string[] | undefined
): SearchHit {
  const document = parseDoc(row.doc)

  let projected = document
  if (attributesToRetrieve && attributesToRetrieve.length > 0) {
    const out: Record<string, unknown> = {}
    for (const attr of attributesToRetrieve) {
      if (attr in document) out[attr] = document[attr]
    }
    projected = out
  }

  const hit: SearchHit = { document: projected }

  if (snippetCols.length > 0) {
    const highlights: Record<string, string> = {}
    for (const col of snippetCols) {
      const raw = row[`__snip_${col}`] as string | null | undefined
      if (raw) highlights[col] = formatSnippet(raw)
    }
    if (Object.keys(highlights).length > 0) hit.highlights = highlights
  }

  return hit
}

function parseDoc(doc: Record<string, unknown> | string): Record<string, unknown> {
  if (typeof doc === 'string') return JSON.parse(doc) as Record<string, unknown>
  return doc
}

function truncate(text: string): string {
  if (Buffer.byteLength(text, 'utf8') <= MAX_TEXT_BYTES) return text
  // Truncate by char count; over-conservative is fine.
  return text.slice(0, MAX_TEXT_BYTES)
}
