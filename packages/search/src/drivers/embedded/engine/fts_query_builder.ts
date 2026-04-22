/**
 * Translate a user-facing query string into a sanitized FTS5 MATCH expression.
 *
 * Supported syntax (subset of Google-style search):
 * - `"foo bar"`   — exact phrase
 * - `-foo`        — exclude documents containing this token
 * - `+foo`        — required (default for all positive tokens — accepted for symmetry)
 * - `foo*`        — prefix match
 *
 * Everything else is treated as a positive ANDed token.
 *
 * Defends against FTS5 syntax injection by stripping or escaping any FTS5
 * operator characters from raw user tokens. The user never gets to write a
 * raw MATCH expression.
 */
export interface FtsExpression {
  /** Final MATCH expression, ready to bind into a query. */
  match: string
  /** The positive tokens (no quotes, no operators) — useful for typo expansion. */
  positiveTokens: string[]
  /** Whether the expression is empty (caller may short-circuit to "match all"). */
  isEmpty: boolean
}

interface ParsedToken {
  text: string
  negate: boolean
  phrase: boolean
  prefix: boolean
}

const FTS5_RESERVED = /["()*:^]/g
const PHRASE_RE = /"([^"]*)"/g

export function compileQuery(input: string): FtsExpression {
  const trimmed = input.trim()
  if (!trimmed) return { match: '', positiveTokens: [], isEmpty: true }

  const tokens = parseTokens(trimmed)
  if (tokens.length === 0) return { match: '', positiveTokens: [], isEmpty: true }

  const positives: string[] = []
  const negatives: string[] = []
  const positiveTokens: string[] = []

  for (const tok of tokens) {
    const rendered = renderToken(tok)
    if (!rendered) continue

    if (tok.negate) {
      negatives.push(rendered)
    } else {
      positives.push(rendered)
      if (!tok.phrase && !tok.prefix) positiveTokens.push(tok.text.toLowerCase())
    }
  }

  if (positives.length === 0 && negatives.length === 0) {
    return { match: '', positiveTokens: [], isEmpty: true }
  }

  // Pure-negative queries can't be expressed in FTS5 — fall back to no-match.
  if (positives.length === 0) {
    return { match: '', positiveTokens: [], isEmpty: true }
  }

  let expr = positives.join(' AND ')
  if (negatives.length > 0) {
    expr = `${expr} NOT (${negatives.join(' OR ')})`
  }

  return { match: expr, positiveTokens, isEmpty: false }
}

/**
 * Re-render a previously parsed query but with extra OR-candidates injected
 * for each positive token. Used by the typo expander.
 */
export function compileQueryWithExpansions(
  input: string,
  expansions: Map<string, string[]>
): FtsExpression {
  const trimmed = input.trim()
  if (!trimmed) return { match: '', positiveTokens: [], isEmpty: true }

  const tokens = parseTokens(trimmed)
  const positives: string[] = []
  const negatives: string[] = []
  const positiveTokens: string[] = []

  for (const tok of tokens) {
    if (tok.negate) {
      const r = renderToken(tok)
      if (r) negatives.push(r)
      continue
    }

    if (tok.phrase || tok.prefix) {
      const r = renderToken(tok)
      if (r) positives.push(r)
      continue
    }

    const sanitized = sanitizeBareToken(tok.text)
    if (!sanitized) continue
    positiveTokens.push(sanitized.toLowerCase())

    const cands = expansions.get(sanitized.toLowerCase()) ?? []
    if (cands.length === 0) {
      positives.push(sanitized)
    } else {
      const all = [sanitized, ...cands].map(t => sanitizeBareToken(t)).filter(Boolean) as string[]
      const unique = Array.from(new Set(all))
      positives.push(`(${unique.join(' OR ')})`)
    }
  }

  if (positives.length === 0) return { match: '', positiveTokens: [], isEmpty: true }

  let expr = positives.join(' AND ')
  if (negatives.length > 0) {
    expr = `${expr} NOT (${negatives.join(' OR ')})`
  }
  return { match: expr, positiveTokens, isEmpty: false }
}

function parseTokens(input: string): ParsedToken[] {
  const tokens: ParsedToken[] = []
  let cursor = 0
  let working = input

  // Pull out phrase tokens first to avoid splitting on inner whitespace.
  working = working.replace(PHRASE_RE, (_, phrase, offset) => {
    const negate = offset > 0 && input[offset - 1] === '-'
    tokens.push({ text: phrase, negate, phrase: true, prefix: false })
    return ' '.repeat(_.length + (negate ? 1 : 0))
  })

  for (const raw of working.split(/\s+/)) {
    if (!raw) continue
    let text = raw
    let negate = false
    let prefix = false

    if (text.startsWith('-')) {
      negate = true
      text = text.slice(1)
    } else if (text.startsWith('+')) {
      text = text.slice(1)
    }
    if (text.endsWith('*')) {
      prefix = true
      text = text.slice(0, -1)
    }
    if (!text) continue

    tokens.push({ text, negate, phrase: false, prefix })
  }

  void cursor
  return tokens
}

function renderToken(tok: ParsedToken): string | null {
  if (tok.phrase) {
    const cleaned = tok.text.replace(/"/g, '').trim()
    if (!cleaned) return null
    return `"${cleaned}"`
  }
  const sanitized = sanitizeBareToken(tok.text)
  if (!sanitized) return null
  return tok.prefix ? `${sanitized}*` : sanitized
}

function sanitizeBareToken(token: string): string {
  // Replace any FTS5 operator characters with a space, then collapse to one
  // word. If only one word survives we use it bare; otherwise wrap in quotes
  // so FTS5 treats it as a phrase rather than two ANDed tokens.
  const cleaned = token.replace(FTS5_RESERVED, ' ').trim()
  if (!cleaned) return ''
  const parts = cleaned.split(/\s+/).filter(Boolean)
  if (parts.length === 1) return parts[0]!
  return `"${parts.join(' ')}"`
}
