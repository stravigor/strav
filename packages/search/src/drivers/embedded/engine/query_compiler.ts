import type { SearchOptions } from '../../../types.ts'
import type { FieldRegistry } from './field_registry.ts'
import type { FtsExpression } from './fts_query_builder.ts'
import { compileFilter } from '../filters/filter_compiler.ts'
import { quoteIdent } from './schema.ts'
import { OPEN_SENTINEL, CLOSE_SENTINEL } from './snippet_formatter.ts'

export interface CompiledSearch {
  /** Main SELECT returning hits + score + snippets. */
  sql: string
  /** Bound parameters for the main SELECT. */
  params: unknown[]
  /** COUNT(*) variant for totalHits. */
  countSql: string
  /** Bound parameters for the count query (subset of `params`). */
  countParams: unknown[]
  /** Names of columns we asked SQLite to return for snippets, in order. */
  snippetColumns: string[]
}

const DEFAULT_SNIPPET_TOKENS = 24

export interface QueryCompilerOptions {
  registry: FieldRegistry
  expression: FtsExpression
  search: SearchOptions
  /** Per-column BM25 weights, matching `registry.searchable` order. Defaults to all-1. */
  weights?: number[]
}

export function compileSearch(opts: QueryCompilerOptions): CompiledSearch {
  const { registry, expression, search, weights } = opts
  const filterableSet = new Set(registry.filterable)
  const sortableSet = new Set(registry.sortable)

  const filter = compileFilter(search.filter, filterableSet)

  const whereParts: string[] = []
  const matchParams: unknown[] = []

  if (!expression.isEmpty) {
    whereParts.push('fts.fts MATCH ?')
    matchParams.push(expression.match)
  }
  if (filter.sql) whereParts.push(filter.sql)

  const where = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : ''

  // BM25 score (negative = better). Defaults to weight 1.0 for every column.
  const ws = (weights ?? registry.searchable.map(() => 1)).map(w => Number(w) || 1)
  const bm25Args = ws.length > 0 ? `, ${ws.join(', ')}` : ''

  const orderBy = compileOrder(search.sort, sortableSet, expression.isEmpty, bm25Args)

  // Build snippet expressions for each field the caller wants highlighted.
  const wantedHighlights = pickHighlightFields(search.attributesToHighlight, registry)
  const snippetSelect = wantedHighlights
    .map(field => {
      const idx = registry.searchable.indexOf(field)
      return `snippet(fts.fts, ${idx}, '${OPEN_SENTINEL}', '${CLOSE_SENTINEL}', ' … ', ${DEFAULT_SNIPPET_TOKENS}) AS ${quoteIdent(`__snip_${field}`)}`
    })
    .join(', ')

  const perPage = Math.max(1, search.perPage ?? 20)
  const page = Math.max(1, search.page ?? 1)
  const offset = (page - 1) * perPage

  const selectCols = [
    'documents.id AS id',
    'documents.doc AS doc',
    expression.isEmpty ? '0 AS score' : `bm25(fts.fts${bm25Args}) AS score`,
  ]
  if (snippetSelect) selectCols.push(snippetSelect)

  const sql = `
    SELECT ${selectCols.join(', ')}
    FROM documents
    ${expression.isEmpty ? '' : 'JOIN fts ON fts.rowid = documents.rowid'}
    ${where}
    ${orderBy}
    LIMIT ? OFFSET ?
  `.trim()

  const countSql = `
    SELECT COUNT(*) AS n
    FROM documents
    ${expression.isEmpty ? '' : 'JOIN fts ON fts.rowid = documents.rowid'}
    ${where}
  `.trim()

  const allParams = [...matchParams, ...filter.params]
  const params = [...allParams, perPage, offset]

  return {
    sql,
    params,
    countSql,
    countParams: allParams,
    snippetColumns: wantedHighlights,
  }
}

function compileOrder(
  sort: string[] | undefined,
  sortableSet: ReadonlySet<string>,
  matchAll: boolean,
  bm25Args: string
): string {
  if (sort && sort.length > 0) {
    const parts: string[] = []
    for (const spec of sort) {
      const [field, dirRaw] = spec.split(':') as [string, string | undefined]
      if (!field || !sortableSet.has(field)) {
        throw new Error(
          `Field "${field}" is not in sortableAttributes. Add it to the index settings before sorting on it.`
        )
      }
      const dir = dirRaw?.toLowerCase() === 'desc' ? 'DESC' : 'ASC'
      parts.push(`${quoteIdent(field)} ${dir}`)
    }
    return `ORDER BY ${parts.join(', ')}`
  }
  if (matchAll) return 'ORDER BY documents.rowid ASC'
  return `ORDER BY bm25(fts.fts${bm25Args}) ASC`
}

function pickHighlightFields(
  requested: string[] | undefined,
  registry: FieldRegistry
): string[] {
  if (registry.usesDefaultTextColumn) return []
  if (!requested || requested.length === 0) return []
  return requested.filter(f => registry.searchable.includes(f))
}
