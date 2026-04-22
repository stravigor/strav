import type { SQL } from 'bun'
import { termsTableName } from '../storage/identifiers.ts'
import type { ResolvedTypoTolerance } from '../types.ts'

/** Tokeniser used for terms-dict maintenance. Mirrors embedded driver. */
export function tokenize(text: string): string[] {
  if (!text) return []
  const tokens: string[] = []
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length >= 2) tokens.push(raw)
  }
  return tokens
}

/** Increment per-document term frequencies (counting unique tokens per doc). */
export async function recordTerms(
  sql: SQL,
  schema: string,
  index: string,
  text: string
): Promise<void> {
  const unique = Array.from(new Set(tokenize(text)))
  if (unique.length === 0) return

  const placeholders = unique.map((_, i) => `($${i + 1})`).join(', ')
  await sql.unsafe(
    `INSERT INTO ${termsTableName(schema, index)} (term) VALUES ${placeholders} ` +
      `ON CONFLICT (term) DO UPDATE SET doc_freq = ${termsTableName(schema, index)}.doc_freq + 1`,
    unique
  )
}

/** Decrement; purge rows that drop to zero. */
export async function unrecordTerms(
  sql: SQL,
  schema: string,
  index: string,
  text: string
): Promise<void> {
  const unique = Array.from(new Set(tokenize(text)))
  if (unique.length === 0) return

  const placeholders = unique.map((_, i) => `$${i + 1}`).join(', ')
  await sql.unsafe(
    `UPDATE ${termsTableName(schema, index)} SET doc_freq = doc_freq - 1 WHERE term IN (${placeholders})`,
    unique
  )
  await sql.unsafe(`DELETE FROM ${termsTableName(schema, index)} WHERE doc_freq <= 0`)
}

/**
 * Look up Levenshtein-near terms via pg_trgm prefilter. When fuzzystrmatch is
 * available we re-rank with bounded Levenshtein for precision (trigram on
 * short tokens is statistically noisy).
 */
export async function expandTokens(
  sql: SQL,
  schema: string,
  index: string,
  tokens: string[],
  settings: ResolvedTypoTolerance,
  hasFuzzystrmatch: boolean,
  maxCandidates = 8
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  if (!settings.enabled || tokens.length === 0) return out

  for (const token of tokens) {
    if (token.length < settings.minTokenLength) continue

    // pg_trgm uses a per-session similarity threshold. We set it transactionally
    // via the WHERE clause comparison instead, so caller's session isn't touched.
    const rows = (await sql.unsafe(
      hasFuzzystrmatch
        ? `WITH cands AS (
             SELECT term FROM ${termsTableName(schema, index)}
             WHERE similarity(term, $1) >= $2 AND term <> $1
             ORDER BY similarity(term, $1) DESC
             LIMIT 32
           )
           SELECT term FROM cands
           WHERE levenshtein(term, $1) <= $3
           LIMIT $4`
        : `SELECT term FROM ${termsTableName(schema, index)}
             WHERE similarity(term, $1) >= $2 AND term <> $1
             ORDER BY similarity(term, $1) DESC
             LIMIT $3`,
      hasFuzzystrmatch
        ? [token, settings.similarity, settings.maxDistance, maxCandidates]
        : [token, settings.similarity, maxCandidates]
    )) as Array<{ term: string }>

    if (rows.length > 0) out.set(token, rows.map(r => r.term))
  }

  return out
}

/** Resolve user-provided typo tolerance settings into concrete numbers. */
export function resolveTypoTolerance(
  setting:
    | 'off'
    | 'auto'
    | { minTokenLength?: number; maxDistance?: number; similarity?: number }
    | undefined
): ResolvedTypoTolerance {
  if (setting === 'off') {
    return { enabled: false, minTokenLength: 4, maxDistance: 1, similarity: 0.4 }
  }
  if (setting === undefined || setting === 'auto') {
    return { enabled: true, minTokenLength: 4, maxDistance: 1, similarity: 0.4 }
  }
  return {
    enabled: true,
    minTokenLength: setting.minTokenLength ?? 4,
    maxDistance: setting.maxDistance ?? 1,
    similarity: setting.similarity ?? 0.4,
  }
}

/** Detect whether fuzzystrmatch.levenshtein is available. */
export async function hasFuzzystrmatch(sql: SQL): Promise<boolean> {
  try {
    const rows = (await sql.unsafe(
      `SELECT 1 FROM pg_proc WHERE proname = 'levenshtein' LIMIT 1`
    )) as Array<Record<string, unknown>>
    return rows.length > 0
  } catch {
    return false
  }
}
