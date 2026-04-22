/**
 * SQLite's snippet() returns text with the requested marker tokens around hits.
 * We use sentinel markers instead of `<mark>` directly so we can safely escape
 * any HTML in the source text first, then swap sentinels for the real tags.
 */
export const OPEN_SENTINEL = 'STRAV_OPEN'
export const CLOSE_SENTINEL = 'STRAV_CLOSE'

export const OPEN_TAG = '<mark>'
export const CLOSE_TAG = '</mark>'

/**
 * Convert SQLite-snippet output (already wrapped in sentinels) into the
 * caller-facing string with `<mark>...</mark>` around hits and HTML-escaped
 * surrounding text.
 */
export function formatSnippet(snippet: string | null | undefined): string {
  if (!snippet) return ''
  return escapeHtml(snippet).replaceAll(OPEN_SENTINEL, OPEN_TAG).replaceAll(CLOSE_SENTINEL, CLOSE_TAG)
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
