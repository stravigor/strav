import type { Middleware } from '../../http/middleware.ts'
import type Session from '../../session/session.ts'

/**
 * CSRF protection middleware.
 *
 * Must be placed **after** the `session()` middleware so that
 * `ctx.get('session')` is available. Works for both anonymous and
 * authenticated sessions.
 *
 * On safe methods (GET, HEAD, OPTIONS) the CSRF token is made available
 * via `ctx.get('csrfToken')` for embedding in forms or meta tags.
 *
 * On state-changing methods, the middleware checks for a matching token in:
 * 1. `X-CSRF-Token` header
 * 2. `X-XSRF-Token` header
 * 3. `_token` field in a JSON or form body
 *
 * @example
 * router.group({ middleware: [session(), csrf()] }, (r) => {
 *   r.post('/login', handleLogin)
 * })
 */
export function csrf(): Middleware {
  return async (ctx, next) => {
    const session = ctx.get<Session>('session')

    if (['GET', 'HEAD', 'OPTIONS'].includes(ctx.method)) {
      if (session) ctx.set('csrfToken', session.csrfToken)
      return next()
    }

    if (!session) {
      return ctx.json({ error: 'Session required for CSRF protection' }, 403)
    }

    // Check headers first
    let token = ctx.header('X-CSRF-Token') ?? ctx.header('X-XSRF-Token')

    // Fall back to request body. ctx.body() returns a plain object for
    // JSON, urlencoded, and multipart bodies (form bodies are flattened
    // from FormData into Record<string, unknown> in Context.body()).
    if (!token) {
      const contentType = ctx.header('content-type') ?? ''
      if (
        contentType.includes('application/json') ||
        contentType.includes('application/x-www-form-urlencoded') ||
        contentType.includes('multipart/form-data')
      ) {
        const body = await ctx.body<Record<string, unknown>>()
        if (body && typeof body._token === 'string') token = body._token
      }
    }

    if (!token || token !== session.csrfToken) {
      return ctx.json({ error: 'CSRF token mismatch' }, 403)
    }

    return next()
  }
}
