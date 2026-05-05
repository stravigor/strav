// @ts-nocheck — Client-side script; requires DOM types provided by the app's bundler config.
/**
 * xfetch — same-origin fetch with automatic CSRF.
 *
 * Drop-in replacement for `fetch()` for state-changing requests to your own
 * API. Reads the CSRF token from `<meta name="csrf" content="...">` (emit
 * with the `@csrf('meta')` template directive in your layout) and injects
 * it as the `X-CSRF-Token` header on POST/PUT/PATCH/DELETE. Defaults
 * `credentials: 'same-origin'` so the session cookie travels with the
 * request. GETs and HEADs pass through unmodified.
 *
 * @example
 * import { xfetch } from '@strav/view/client'
 *
 * const res = await xfetch('/api/projects', {
 *   method: 'POST',
 *   headers: { 'Content-Type': 'application/json' },
 *   body: JSON.stringify({ name: 'New project' }),
 * })
 */

const STATE_CHANGING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

let cachedToken: string | null | undefined

function readCsrfToken(): string {
  if (cachedToken !== undefined) return cachedToken ?? ''
  const meta = document.querySelector<HTMLMetaElement>('meta[name="csrf"]')
  cachedToken = meta?.content ?? null
  return cachedToken ?? ''
}

/**
 * Reset the cached CSRF token. Call after the session is regenerated
 * (post-login, post-logout) if you've also updated the meta tag in place.
 * Most apps don't need this — a full page navigation reloads the meta tag.
 */
export function resetCsrfTokenCache(): void {
  cachedToken = undefined
}

export function xfetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const method = (init.method ?? 'GET').toUpperCase()
  const next: RequestInit = { credentials: 'same-origin', ...init }

  if (STATE_CHANGING.has(method)) {
    const token = readCsrfToken()
    if (token) {
      const headers = new Headers(init.headers)
      // Preserve any user-set token; only inject when absent.
      if (!headers.has('X-CSRF-Token') && !headers.has('X-XSRF-Token')) {
        headers.set('X-CSRF-Token', token)
      }
      next.headers = headers
    }
  }

  return fetch(input, next)
}
