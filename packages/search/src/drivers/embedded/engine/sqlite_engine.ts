import { Database } from 'bun:sqlite'
import type {
  SearchDocument,
  SearchOptions,
  SearchResult,
  SearchHit,
  IndexSettings,
} from '../../../types.ts'
import type { ResolvedTypoTolerance } from '../types.ts'
import { FieldRegistry } from './field_registry.ts'
import { applyConnectionPragmas, createSchema, quoteIdent } from './schema.ts'
import { compileQuery, compileQueryWithExpansions } from './fts_query_builder.ts'
import { compileSearch } from './query_compiler.ts'
import { formatSnippet } from './snippet_formatter.ts'
import { recordTerms, unrecordTerms, expandTokens } from './typo_expander.ts'

export interface SqliteEngineOptions {
  path: string
  synchronous: 'OFF' | 'NORMAL' | 'FULL'
  typoTolerance: ResolvedTypoTolerance
  indexName: string
  settings?: IndexSettings
}

/**
 * One SqliteEngine wraps a single index (a single SQLite file). The driver
 * holds a Map<indexName, SqliteEngine> and lazily instantiates per index.
 */
export class SqliteEngine {
  readonly db: Database
  readonly registry: FieldRegistry
  private readonly typo: ResolvedTypoTolerance
  private readonly indexName: string

  constructor(opts: SqliteEngineOptions) {
    this.db = new Database(opts.path)
    applyConnectionPragmas(this.db, opts.synchronous)
    this.registry = new FieldRegistry(opts.settings)
    createSchema(this.db, this.registry)
    this.typo = opts.typoTolerance
    this.indexName = opts.indexName
  }

  // ── Writes ──────────────────────────────────────────────────────────────

  upsert(id: string | number, document: Record<string, unknown>): void {
    this.runUpsertBatch([{ id, document }])
  }

  upsertMany(documents: SearchDocument[]): void {
    if (documents.length === 0) return
    const batch = documents.map(d => {
      const { id, ...rest } = d
      return { id, document: rest as Record<string, unknown> }
    })
    this.runUpsertBatch(batch)
  }

  delete(id: string | number): void {
    this.runDeleteBatch([id])
  }

  deleteMany(ids: Array<string | number>): void {
    if (ids.length === 0) return
    this.runDeleteBatch(ids)
  }

  /** Remove all documents from the index, leaving the schema in place. */
  flush(): void {
    const tx = this.db.transaction(() => {
      this.db.exec('DELETE FROM fts')
      this.db.exec('DELETE FROM documents')
      this.db.exec('DELETE FROM terms_dict')
    })
    tx()
  }

  /** Force-merge FTS5 segments into one. Run periodically (e.g. nightly via CLI). */
  optimize(): void {
    this.db.exec("INSERT INTO fts(fts) VALUES('optimize')")
  }

  close(): void {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    } catch {
      // Ignore — closing should never throw on a checkpoint failure
    }
    this.db.close()
  }

  // ── Reads ───────────────────────────────────────────────────────────────

  search(query: string, options?: SearchOptions): SearchResult {
    const start = performance.now()
    const opts = options ?? {}
    const expression = this.buildExpression(query)

    const compiled = compileSearch({
      registry: this.registry,
      expression,
      search: opts,
    })

    const rows = this.db
      .prepare<RawHitRow, any[]>(compiled.sql)
      .all(...(compiled.params as any[]))
    const totalRow = this.db
      .prepare<{ n: number }, any[]>(compiled.countSql)
      .get(...(compiled.countParams as any[]))

    const projection = opts.attributesToRetrieve
    const hits: SearchHit[] = rows.map(row => projectHit(row, compiled.snippetColumns, projection))

    return {
      hits,
      totalHits: totalRow?.n ?? hits.length,
      page: Math.max(1, opts.page ?? 1),
      perPage: Math.max(1, opts.perPage ?? 20),
      processingTimeMs: Math.round(performance.now() - start),
    }
  }

  // ── Internals ───────────────────────────────────────────────────────────

  private buildExpression(query: string) {
    const base = compileQuery(query)
    if (!this.typo.enabled || base.isEmpty || base.positiveTokens.length === 0) return base

    const expansions = expandTokens(this.db, base.positiveTokens, this.typo)
    if (expansions.size === 0) return base
    return compileQueryWithExpansions(query, expansions)
  }

  private runUpsertBatch(items: Array<{ id: string | number; document: Record<string, unknown> }>) {
    const insertDoc = this.prepareInsertDoc()
    const fetchExisting = this.db.prepare<
      { rowid: number; doc: string },
      [string]
    >('SELECT rowid, doc FROM documents WHERE id = ?')
    const insertFts = this.prepareInsertFts()
    const deleteFts = this.db.prepare('DELETE FROM fts WHERE rowid = ?')
    const indexName = this.indexName

    const tx = this.db.transaction(() => {
      for (const { id, document: doc } of items) {
        const idStr = String(id)
        const docJson = JSON.stringify({ id, ...doc })
        const ftsValues = this.registry.projectFtsValues(doc)
        const typedValues = this.registry.projectTypedValues(doc)
        const newText = this.registry.concatSearchableText(doc)

        const existing = fetchExisting.get(idStr)
        if (existing) {
          // Update path
          const oldDoc = JSON.parse(existing.doc) as Record<string, unknown>
          const oldText = this.registry.concatSearchableText(oldDoc)
          unrecordTerms(this.db, oldText)

          deleteFts.run(existing.rowid)
          insertFts.run(existing.rowid as any, ...(ftsValues as any[]))
          this.updateDocumentRow(existing.rowid, docJson, typedValues)
        } else {
          const result = insertDoc.run(idStr as any, docJson as any, ...(typedValues as any[]))
          const rowid = Number(result.lastInsertRowid)
          insertFts.run(rowid as any, ...(ftsValues as any[]))
        }

        recordTerms(this.db, newText)
      }
    })
    void indexName
    tx()
  }

  private runDeleteBatch(ids: Array<string | number>) {
    const fetchExisting = this.db.prepare<
      { rowid: number; doc: string },
      [string]
    >('SELECT rowid, doc FROM documents WHERE id = ?')
    const deleteDoc = this.db.prepare('DELETE FROM documents WHERE id = ?')
    const deleteFts = this.db.prepare('DELETE FROM fts WHERE rowid = ?')

    const tx = this.db.transaction(() => {
      for (const id of ids) {
        const idStr = String(id)
        const existing = fetchExisting.get(idStr)
        if (!existing) continue
        const oldDoc = JSON.parse(existing.doc) as Record<string, unknown>
        unrecordTerms(this.db, this.registry.concatSearchableText(oldDoc))
        deleteFts.run(existing.rowid)
        deleteDoc.run(idStr)
      }
    })
    tx()
  }

  private prepareInsertDoc() {
    const cols = ['id', 'doc', ...this.registry.typedColumns.map(quoteIdent)]
    const placeholders = cols.map(() => '?').join(', ')
    return this.db.prepare(
      `INSERT INTO documents (${cols.join(', ')}) VALUES (${placeholders})`
    )
  }

  private updateDocumentRow(rowid: number, docJson: string, typedValues: unknown[]) {
    const sets = ['doc = ?']
    for (const col of this.registry.typedColumns) sets.push(`${quoteIdent(col)} = ?`)
    const sql = `UPDATE documents SET ${sets.join(', ')} WHERE rowid = ?`
    this.db.prepare(sql).run(docJson as any, ...(typedValues as any[]), rowid as any)
  }

  private prepareInsertFts() {
    const cols = ['rowid', ...this.registry.searchable.map(quoteIdent)]
    const placeholders = cols.map(() => '?').join(', ')
    return this.db.prepare(`INSERT INTO fts (${cols.join(', ')}) VALUES (${placeholders})`)
  }
}

interface RawHitRow {
  id: string
  doc: string
  score: number
  [snippetCol: string]: unknown
}

function projectHit(
  row: RawHitRow,
  snippetCols: string[],
  attributesToRetrieve: string[] | undefined
): SearchHit {
  const document = JSON.parse(row.doc) as Record<string, unknown>

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
