import { quoteLiteral } from '../storage/identifiers.ts'

/**
 * Translate a user-facing query string into one that's safe for
 * `websearch_to_tsquery`, plus extract positive tokens for typo expansion.
 *
 * websearch_to_tsquery already accepts Google-style syntax:
 * - `"foo bar"`  — phrase
 * - `-foo`       — exclude
 * - `OR`/`AND`   — boolean (case-insensitive)
 *
 * It does NOT support prefix matching (`foo*`); we recognise that ourselves
 * and emit a separate `to_tsquery('foo:*')` ORed onto the result.
 */
export interface ParsedQuery {
  /** The raw query, ready to pass to `websearch_to_tsquery`. */
  websearch: string
  /** Positive bare tokens (no quotes/operators) — used for typo expansion. */
  positiveTokens: string[]
  /** Prefix tokens from `foo*` syntax — emitted separately to `to_tsquery`. */
  prefixTokens: string[]
  /** Whether the input was effectively empty. */
  isEmpty: boolean
}

const PHRASE_RE = /"([^"]*)"/g

export function parseQuery(input: string): ParsedQuery {
  const trimmed = input.trim()
  if (!trimmed) {
    return { websearch: '', positiveTokens: [], prefixTokens: [], isEmpty: true }
  }

  const positiveTokens: string[] = []
  const prefixTokens: string[] = []

  // Strip phrases first so we don't tokenize their inner whitespace.
  const scratch = trimmed.replace(PHRASE_RE, ' ')
  for (const raw of scratch.split(/\s+/)) {
    if (!raw) continue
    let text = raw
    if (text.startsWith('-') || text.startsWith('+')) text = text.slice(1)
    if (text.endsWith('*')) {
      const stem = text.slice(0, -1).toLowerCase().replace(/[^\p{L}\p{N}_-]/gu, '')
      if (stem) prefixTokens.push(stem)
      continue
    }
    if (text.toUpperCase() === 'AND' || text.toUpperCase() === 'OR') continue
    const norm = text.toLowerCase().replace(/[^\p{L}\p{N}_-]/gu, '')
    if (norm.length >= 2) positiveTokens.push(norm)
  }

  return { websearch: trimmed, positiveTokens, prefixTokens, isEmpty: false }
}

/**
 * Build a tsquery SQL expression that ORs together the user's websearch query,
 * any prefix tokens, and any typo-expanded alternatives. Returns the
 * expression + the user-text bindings (the language is embedded as a literal
 * since it's a per-index server-controlled value, not user input).
 *
 * `startAt` is the placeholder counter the caller has already used. Returned
 * `paramCount` lets the caller continue numbering for filter/limit/offset.
 */
export function buildTsqueryExpression(
  parsed: ParsedQuery,
  expansions: Map<string, string[]>,
  language: string,
  startAt = 0
): { sql: string; params: string[]; paramCount: number } {
  const params: string[] = []
  const fragments: string[] = []
  const lang = `${quoteLiteral(language)}::regconfig`
  let cursor = startAt
  const ph = () => `$${++cursor}`

  if (parsed.websearch) {
    params.push(parsed.websearch)
    fragments.push(`websearch_to_tsquery(${lang}, ${ph()})`)
  }

  for (const stem of parsed.prefixTokens) {
    params.push(`${stem}:*`)
    fragments.push(`to_tsquery(${lang}, ${ph()})`)
  }

  for (const token of parsed.positiveTokens) {
    const cands = expansions.get(token)
    if (!cands || cands.length === 0) continue
    const expr = cands.map(sanitiseTsTerm).filter(Boolean).join(' | ')
    if (!expr) continue
    params.push(expr)
    fragments.push(`to_tsquery(${lang}, ${ph()})`)
  }

  if (fragments.length === 0) {
    return { sql: '', params: [], paramCount: 0 }
  }
  return { sql: fragments.join(' || '), params, paramCount: cursor - startAt }
}

/** Sanitise a single term for inclusion in a manually built tsquery. */
function sanitiseTsTerm(term: string): string {
  return term.toLowerCase().replace(/[^\p{L}\p{N}_-]/gu, '')
}
