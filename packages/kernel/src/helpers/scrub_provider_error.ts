import { redact } from './redact.ts'

/**
 * Token-shape patterns that should be redacted out of free-form error
 * text. Upstream provider response bodies and network error messages
 * occasionally embed credentials (when a provider echoes request
 * details, when a Node/Bun network error includes the URL with auth
 * query params, etc.) — none of which we want surfacing in logs or
 * exception traces.
 */
const TOKEN_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Bearer tokens — applied first so the header-style pattern below
  // doesn't try to swallow `Bearer` as the value of `Authorization:`.
  [/Bearer\s+[A-Za-z0-9._\-+/=]{6,}/gi, 'Bearer [REDACTED]'],
  // `sk-…` / `sk_…` style API keys (Anthropic, OpenAI, etc.).
  [/\bsk-[A-Za-z0-9_\-]{6,}/g, 'sk-[REDACTED]'],
  [/\bsk_[A-Za-z0-9_\-]{6,}/g, 'sk_[REDACTED]'],
  // Header-style key/value embeds. We deliberately exclude `authorization`
  // here because the Bearer pattern already handles its standard form
  // and adding it back would re-match `Authorization: Bearer [REDACTED]`
  // and double-redact the line.
  [/(["']?)(x-api-key|x-goog-api-key|api[-_]?key)\1\s*[:=]\s*["']?[A-Za-z0-9._\-+/=]{6,}["']?/gi, '$2=[REDACTED]'],
  // Query-string credentials.
  [/(\?|&)(api[-_]?key|access[-_]?token|key|token)=([^&\s"]+)/gi, '$1$2=[REDACTED]'],
]

/**
 * Scrub credentials out of upstream-provider error text before it is
 * wrapped in `ExternalServiceError`.
 *
 * If the text is JSON, parse + recursively redact + re-stringify (so
 * structured fields named `password`/`token`/`secret`/etc. get the
 * standard `[REDACTED]` replacement from `redact()`).
 *
 * Otherwise apply a regex pass for common credential shapes embedded
 * in plain text (Bearer tokens, `sk-` / `sk_` prefixed keys, query-
 * string credentials, header-style key/value pairs).
 *
 * Empty / falsy input is returned unchanged. The function is
 * deterministic and idempotent — applying it twice is safe.
 *
 * @example
 * import { scrubProviderError } from '@strav/kernel'
 * import { ExternalServiceError } from '@strav/kernel'
 *
 * if (!response.ok) {
 *   const text = await response.text()
 *   throw new ExternalServiceError(this.name, response.status, scrubProviderError(text))
 * }
 */
export function scrubProviderError(text: string | undefined | null): string {
  if (!text) return text ?? ''

  // Try JSON first — most provider error bodies are structured.
  try {
    const parsed = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object') {
      return JSON.stringify(redact(parsed))
    }
  } catch {
    // not JSON — fall through
  }

  let scrubbed = text
  for (const [pattern, replacement] of TOKEN_PATTERNS) {
    scrubbed = scrubbed.replace(pattern, replacement)
  }
  return scrubbed
}
