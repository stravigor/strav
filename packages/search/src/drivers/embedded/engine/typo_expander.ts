import type { Database } from 'bun:sqlite'
import type { ResolvedTypoTolerance } from '../types.ts'

/**
 * Plain-text tokeniser for the terms dictionary.
 *
 * Lowercases input, splits on non-letter/digit boundaries, drops tokens shorter
 * than 2 characters. We deliberately do NOT apply Porter stemming here because:
 *
 * - Most typos are on rare/proper nouns (e.g. customer names, product SKUs)
 *   which Porter doesn't transform anyway.
 * - Mirroring SQLite's stem inside JS would require shipping a Porter
 *   implementation just for the dictionary, which is a lot of code for the
 *   marginal gain on common-word typos.
 *
 * The candidate term we feed back into FTS5 is then re-stemmed by FTS5 itself,
 * so the lookup still works.
 */
export function tokenize(text: string): string[] {
  if (!text) return []
  const tokens: string[] = []
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length >= 2) tokens.push(raw)
  }
  return tokens
}

/** Add a document's tokens to the terms dictionary, incrementing per unique term. */
export function recordTerms(db: Database, text: string): void {
  const unique = new Set(tokenize(text))
  if (unique.size === 0) return

  const stmt = db.prepare(
    'INSERT INTO terms_dict (term, doc_freq) VALUES (?, 1) ' +
      'ON CONFLICT(term) DO UPDATE SET doc_freq = doc_freq + 1'
  )
  for (const term of unique) stmt.run(term)
}

/** Decrement a document's tokens; remove rows that drop to zero. */
export function unrecordTerms(db: Database, text: string): void {
  const unique = new Set(tokenize(text))
  if (unique.size === 0) return

  const dec = db.prepare('UPDATE terms_dict SET doc_freq = doc_freq - 1 WHERE term = ?')
  const purge = db.prepare('DELETE FROM terms_dict WHERE doc_freq <= 0')
  for (const term of unique) dec.run(term)
  purge.run()
}

/**
 * For each token, return up to `maxCandidates` near-misses already present in
 * the dictionary, using Levenshtein distance ≤ settings.maxDistance.
 */
export function expandTokens(
  db: Database,
  tokens: string[],
  settings: ResolvedTypoTolerance,
  maxCandidates = 8
): Map<string, string[]> {
  const out = new Map<string, string[]>()
  if (!settings.enabled) return out

  const stmt = db.prepare<{ term: string }, [number, number]>(
    'SELECT term FROM terms_dict WHERE length(term) BETWEEN ? AND ?'
  )

  for (const token of tokens) {
    if (token.length < settings.minTokenLength) continue

    const minLen = Math.max(1, token.length - settings.maxDistance)
    const maxLen = token.length + settings.maxDistance

    const candidates: string[] = []
    for (const row of stmt.all(minLen, maxLen)) {
      if (row.term === token) continue
      if (levenshtein(token, row.term, settings.maxDistance) <= settings.maxDistance) {
        candidates.push(row.term)
        if (candidates.length >= maxCandidates) break
      }
    }
    if (candidates.length > 0) out.set(token, candidates)
  }

  return out
}

/** Resolve user-provided typo tolerance settings into concrete numbers. */
export function resolveTypoTolerance(
  setting:
    | 'off'
    | 'auto'
    | { minTokenLength?: number; maxDistance?: number }
    | undefined
): ResolvedTypoTolerance {
  if (setting === 'off') {
    return { enabled: false, minTokenLength: 4, maxDistance: 1 }
  }
  if (setting === undefined || setting === 'auto') {
    return { enabled: true, minTokenLength: 4, maxDistance: 1 }
  }
  return {
    enabled: true,
    minTokenLength: setting.minTokenLength ?? 4,
    maxDistance: setting.maxDistance ?? 1,
  }
}

/**
 * Bounded Levenshtein distance: returns max+1 once it can prove the distance
 * exceeds `max` so we can short-circuit. Operates on UTF-16 code units, which
 * is fine for our supported (ASCII-ish) corpora.
 */
function levenshtein(a: string, b: string, max: number): number {
  if (a === b) return 0
  if (Math.abs(a.length - b.length) > max) return max + 1
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length

  const aLen = a.length
  const bLen = b.length
  let prev = new Array<number>(bLen + 1).fill(0)
  let curr = new Array<number>(bLen + 1).fill(0)
  for (let j = 0; j <= bLen; j++) prev[j] = j

  for (let i = 1; i <= aLen; i++) {
    curr[0] = i
    let rowMin = curr[0]!
    for (let j = 1; j <= bLen; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1
      curr[j] = Math.min(prev[j]! + 1, curr[j - 1]! + 1, prev[j - 1]! + cost)
      if (curr[j]! < rowMin) rowMin = curr[j]!
    }
    if (rowMin > max) return max + 1
    ;[prev, curr] = [curr, prev]
  }
  return prev[bLen]!
}
