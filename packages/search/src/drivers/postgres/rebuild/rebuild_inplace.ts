import type { SQL } from 'bun'
import type { FieldRegistry } from '../engine/field_registry.ts'
import { indexTableName, quoteLiteral, quoteIdent } from '../storage/identifiers.ts'
import { RebuildRequiredError } from '../errors.ts'

/** Tier boundaries for rebuild strategy selection. */
const TIER1_MAX = 100_000
const TIER2_MAX = 10_000_000

/** Batch size for tier-2 batched UPDATE. */
const BATCH_SIZE = 5_000

export interface RebuildOptions {
  /** If true, run REINDEX on the GIN index after the rebuild. Default true. */
  reindex?: boolean
  /** Per-batch sleep in milliseconds (tier 2 only). Default 50. */
  pauseMs?: number
  /** Optional progress callback fired after each batch. */
  onProgress?: (done: number, total: number) => void
}

/**
 * Rebuild an index's `fts` column in place using the current registry's
 * language + weight scheme. Picks tier by row count:
 * - < 100k → single UPDATE
 * - 100k-10M → batched UPDATE with pauses
 * - > 10M → RebuildRequiredError (defer to v1.1 swap strategy)
 */
export async function rebuildInPlace(
  sql: SQL,
  schema: string,
  index: string,
  registry: FieldRegistry,
  options: RebuildOptions = {}
): Promise<{ tier: 1 | 2; rows: number; elapsedMs: number }> {
  const reindex = options.reindex ?? true
  const pauseMs = options.pauseMs ?? 50
  const table = indexTableName(schema, index)
  const start = performance.now()

  const countRows = (await sql.unsafe(
    `SELECT COUNT(*)::bigint AS n FROM ${table}`
  )) as Array<{ n: string | number }>
  const total = Number(countRows[0]?.n ?? 0)

  if (total > TIER2_MAX) {
    throw new RebuildRequiredError(
      `Index "${index}" has ${total} rows (>${TIER2_MAX}). ` +
        `In-place / batched rebuild is unsafe at this scale. ` +
        `Use the v1.1 dual-table swap strategy (not yet shipped).`
    )
  }

  const ftsExpr = buildSetFtsExpression(registry)

  if (total <= TIER1_MAX) {
    await sql.unsafe(`UPDATE ${table} SET fts = ${ftsExpr}`)
    if (reindex) await reindexGin(sql, schema, index)
    return { tier: 1, rows: total, elapsedMs: Math.round(performance.now() - start) }
  }

  // Tier 2: batched update keyed by id, with pauses for autovacuum.
  let cursor: string | null = null
  let done = 0

  while (true) {
    const where = cursor === null ? '' : `WHERE id > $1`
    const params = cursor === null ? [] : [cursor]
    const batch = (await sql.unsafe(
      `SELECT id FROM ${table} ${where} ORDER BY id LIMIT ${BATCH_SIZE}`,
      params
    )) as Array<{ id: string }>
    if (batch.length === 0) break

    const ids = batch.map(r => r.id)
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(', ')
    await sql.unsafe(
      `UPDATE ${table} SET fts = ${ftsExpr} WHERE id IN (${placeholders})`,
      ids
    )

    done += batch.length
    cursor = ids[ids.length - 1]!
    options.onProgress?.(done, total)
    if (pauseMs > 0) await new Promise(r => setTimeout(r, pauseMs))
  }

  if (reindex) await reindexGin(sql, schema, index)
  return { tier: 2, rows: total, elapsedMs: Math.round(performance.now() - start) }
}

function buildSetFtsExpression(registry: FieldRegistry): string {
  const lang = `${quoteLiteral(registry.language)}::regconfig`
  if (registry.usesDefaultTextColumn) {
    return (
      `setweight(to_tsvector(${lang}, ` +
      `(SELECT coalesce(string_agg(value, ' '), '') FROM jsonb_each_text(doc))), 'A')`
    )
  }
  return registry.searchable
    .map(attr => {
      const weight = registry.weights.get(attr)!
      return (
        `setweight(to_tsvector(${lang}, coalesce(doc->>${quoteLiteral(attr)}, '')), '${weight}')`
      )
    })
    .join(' || ')
}

async function reindexGin(sql: SQL, schema: string, index: string): Promise<void> {
  const ginName = `${quoteIdent(schema)}.${quoteIdent(`search_${index}_fts_gin`)}`
  await sql.unsafe(`REINDEX INDEX ${ginName}`)
}
