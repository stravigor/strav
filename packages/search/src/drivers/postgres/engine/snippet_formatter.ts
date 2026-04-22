/**
 * `ts_headline` returns text with literal `<mark>` / `</mark>` markers around
 * matched terms. The surrounding text comes from the source document — which
 * may itself contain HTML the caller didn't escape. We HTML-escape the
 * snippet, then restore the marker tags, mirroring what the embedded driver
 * does with sentinel markers.
 */
const OPEN_TAG = '<mark>'
const CLOSE_TAG = '</mark>'
const OPEN_PLACEHOLDER = 'STRAV_OPEN'
const CLOSE_PLACEHOLDER = 'STRAV_CLOSE'

export function formatSnippet(snippet: string | null | undefined): string {
  if (!snippet) return ''
  // Replace ts_headline's literal tags with sentinel control bytes that
  // can't appear in source text, escape, then swap back.
  const swapped = snippet
    .replaceAll(OPEN_TAG, OPEN_PLACEHOLDER)
    .replaceAll(CLOSE_TAG, CLOSE_PLACEHOLDER)
  const escaped = escapeHtml(swapped)
  return escaped.replaceAll(OPEN_PLACEHOLDER, OPEN_TAG).replaceAll(CLOSE_PLACEHOLDER, CLOSE_TAG)
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
