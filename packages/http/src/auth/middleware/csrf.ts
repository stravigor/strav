import type { Middleware } from '../../http/middleware.ts'
import type Context from '../../http/context.ts'
import type Session from '../../session/session.ts'

/**
 * Why a CSRF check failed, passed to {@link CsrfOptions.onFail}.
 *
 * - `no-session` — the request has no session, so no token can be verified.
 * - `missing-token` — no token was supplied in a header or the request body.
 * - `token-mismatch` — a token was supplied but did not match the session.
 */
export type CsrfFailureReason = 'no-session' | 'missing-token' | 'token-mismatch'

/** Options for the {@link csrf} middleware. */
export interface CsrfOptions {
  /**
   * Custom response when the CSRF check fails. Receives the request context
   * and the reason for the failure, mirroring `rateLimit()`'s `onLimitReached`.
   *
   * Use this to shape the rejection to an app's error envelope. When unset,
   * `csrf()` keeps its default `{ error: string }` 403 body.
   *
   * @example
   * csrf({
   *   onFail: (ctx, reason) =>
   *     ctx.json({ error_code: 'CSRF_FAILED', message: reason, details: {} }, 403),
   * })
   */
  onFail?: (ctx: Context, reason: CsrfFailureReason) => Response | Promise<Response>
}

/** Default 403 body for each failure reason, used when `onFail` is unset. */
function defaultFailure(ctx: Context, reason: CsrfFailureReason): Response {
  if (reason === 'no-session') {
    return ctx.json({ error: 'Session required for CSRF protection' }, 403)
  }
  return ctx.json({ error: 'CSRF token mismatch' }, 403)
}

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
 * On a failed check the middleware returns a `403`. Pass `onFail` to shape
 * that response to a custom error envelope; otherwise a default
 * `{ error: string }` body is returned.
 *
 * @example
 * router.group({ middleware: [session(), csrf()] }, (r) => {
 *   r.post('/login', handleLogin)
 * })
 *
 * @example
 * // Shape the rejection to a structured error envelope.
 * csrf({
 *   onFail: (ctx, reason) =>
 *     ctx.json({ error_code: 'CSRF_FAILED', message: reason, details: {} }, 403),
 * })
 */
export function csrf(options: CsrfOptions = {}): Middleware {
  const { onFail } = options
  const fail = (ctx: Context, reason: CsrfFailureReason): Response | Promise<Response> =>
    onFail ? onFail(ctx, reason) : defaultFailure(ctx, reason)

  return async (ctx, next) => {
    const session = ctx.get<Session>('session')

    if (['GET', 'HEAD', 'OPTIONS'].includes(ctx.method)) {
      if (session) ctx.set('csrfToken', session.csrfToken)
      return next()
    }

    if (!session) {
      return fail(ctx, 'no-session')
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

    if (!token) {
      return fail(ctx, 'missing-token')
    }

    if (token !== session.csrfToken) {
      return fail(ctx, 'token-mismatch')
    }

    return next()
  }
}
