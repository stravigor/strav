import type { SearchOptions } from '../../../types.ts'
import type { FieldRegistry } from './field_registry.ts'
import { compileFilter } from '../filters/filter_compiler.ts'
import { quoteIdent, quoteLiteral, indexTableName } from '../storage/identifiers.ts'

export interface CompiledSearch {
  /** Main SELECT returning hits + score + snippets. */
  sql: string
  /** Bound parameters for the SELECT. */
  params: unknown[]
  /** COUNT(*) variant for totalHits (uses the same MATCH + filter, no rank/snippets). */
  countSql: string
  countParams: unknown[]
  /** Names of headlight columns we asked PG to return (`__snip_<field>`). */
  snippetColumns: string[]
}

const DEFAULT_HEADLINE_OPTIONS =
  'StartSel=<mark>,StopSel=</mark>,MaxWords=35,MinWords=15,ShortWord=0,HighlightAll=false,MaxFragments=2'

/** ts_rank_cd normalization bitmask. 1 = divide by 1+log(doc length), 32 = rank/(rank+1). */
const DEFAULT_RANK_FLAGS = 1 | 32

export interface QueryCompilerOptions {
  registry: FieldRegistry
  schema: string
  index: string
  /** Output of buildTsqueryExpression — already starts at placeholder 1. */
  tsquery: { sql: string; params: string[] }
  search: SearchOptions
}

export function compileSearch(opts: QueryCompilerOptions): CompiledSearch {
  const { registry, schema, index, tsquery, search } = opts
  const filterableSet = new Set(registry.filterable)
  const sortableSet = new Set(registry.sortable)

  const filter = compileFilter(search.filter, filterableSet, tsquery.params.length)
  const params: unknown[] = [...tsquery.params, ...filter.params]

  const whereParts: string[] = []
  if (tsquery.sql) whereParts.push(`fts @@ q.query`)
  if (filter.sql) whereParts.push(filter.sql)
  const where = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : ''

  const orderBy = compileOrder(search.sort, sortableSet, !tsquery.sql)

  const perPage = Math.max(1, search.perPage ?? 20)
  const page = Math.max(1, search.page ?? 1)
  const offset = (page - 1) * perPage

  const limitPh = `$${params.length + 1}`
  const offsetPh = `$${params.length + 2}`
  params.push(perPage, offset)

  const wantedHighlights = pickHighlightFields(search.attributesToHighlight, registry)
  const lang = `${quoteLiteral(registry.language)}::regconfig`

  // The ranked CTE: filter + order + LIMIT, returns top-K rows + score only.
  // ts_headline runs only on this top-K slice (huge perf win — ts_headline
  // re-tokenizes raw text per row).
  const cte = tsquery.sql
    ? `WITH q AS (SELECT (${tsquery.sql}) AS query),
           ranked AS (
             SELECT id, doc, ts_rank_cd(fts, q.query, ${DEFAULT_RANK_FLAGS}) AS score
               FROM ${indexTableName(schema, index)}, q
               ${where}
               ${orderBy}
               LIMIT ${limitPh} OFFSET ${offsetPh}
           )`
    : `WITH ranked AS (
             SELECT id, doc, 0::real AS score
               FROM ${indexTableName(schema, index)}
               ${where}
               ${orderBy}
               LIMIT ${limitPh} OFFSET ${offsetPh}
           )`

  const snippetCols = wantedHighlights.map(field => {
    return `ts_headline(${lang}, coalesce(doc->>${quoteLiteral(field)}, ''), ` +
      `${tsquery.sql ? '(SELECT query FROM q)' : 'plainto_tsquery(' + lang + ", '')"}, ` +
      `${quoteLiteral(DEFAULT_HEADLINE_OPTIONS)}) AS ${quoteIdent(`__snip_${field}`)}`
  })

  const selectCols = ['id', 'doc', 'score', ...snippetCols]

  // Re-emit ORDER BY in the outer SELECT — Postgres doesn't preserve row
  // order across CTE boundaries.
  const outerOrderBy = compileOuterOrder(search.sort, sortableSet, !tsquery.sql)
  const sql = `${cte}
    SELECT ${selectCols.join(', ')}
    FROM ranked
    ${outerOrderBy}`

  // Count uses the MATCH + filter, but no rank/snippet/limit.
  const countSql = tsquery.sql
    ? `SELECT COUNT(*)::int AS n FROM ${indexTableName(schema, index)}, ` +
        `(SELECT (${tsquery.sql}) AS query) q ${where}`
    : `SELECT COUNT(*)::int AS n FROM ${indexTableName(schema, index)} ${where}`

  const countParams = [...tsquery.params, ...filter.params]

  return {
    sql,
    params,
    countSql,
    countParams,
    snippetColumns: wantedHighlights,
  }
}

function compileOrder(
  sort: string[] | undefined,
  sortableSet: ReadonlySet<string>,
  matchAll: boolean
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
  if (matchAll) return 'ORDER BY id ASC'
  return 'ORDER BY score DESC'
}

/** ORDER BY for the outer SELECT — references columns visible on `ranked`. */
function compileOuterOrder(
  sort: string[] | undefined,
  sortableSet: ReadonlySet<string>,
  matchAll: boolean
): string {
  if (sort && sort.length > 0) {
    // The CTE only exposes id, doc, score — sortable columns aren't in scope,
    // so we sort by `doc->>'field'` lexically. Same lex semantics as the
    // typed generated columns (which are TEXT) used inside the CTE.
    const parts: string[] = []
    for (const spec of sort) {
      const [field, dirRaw] = spec.split(':') as [string, string | undefined]
      if (!field || !sortableSet.has(field)) continue
      const dir = dirRaw?.toLowerCase() === 'desc' ? 'DESC' : 'ASC'
      parts.push(`(doc->>${quoteLiteral(field)}) ${dir}`)
    }
    return parts.length > 0 ? `ORDER BY ${parts.join(', ')}` : ''
  }
  if (matchAll) return 'ORDER BY id ASC'
  return 'ORDER BY score DESC'
}

function pickHighlightFields(
  requested: string[] | undefined,
  registry: FieldRegistry
): string[] {
  if (registry.usesDefaultTextColumn) return []
  if (!requested || requested.length === 0) return []
  return requested.filter(f => registry.searchable.includes(f))
}
