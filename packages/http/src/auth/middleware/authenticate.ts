import type { Middleware } from '../../http/middleware.ts'
import type Context from '../../http/context.ts'
import Auth from '../auth.ts'
import type Session from '../../session/session.ts'
import AccessToken from '../access_token.ts'

/**
 * Why an authentication check failed, passed to {@link AuthOptions.onFail}.
 *
 * Session guard:
 * - `no-session` — the request carried no session at all.
 * - `unauthenticated` — a session exists but is not authenticated.
 * - `session-expired` — the session is authenticated but has expired.
 *
 * Token guard:
 * - `no-token` — no `Authorization: Bearer …` header was supplied.
 * - `invalid-token` — the bearer token did not validate.
 *
 * Either guard:
 * - `user-not-found` — the guard resolved a user id but no user matched it.
 */
export type AuthFailureReason =
  | 'no-session'
  | 'unauthenticated'
  | 'session-expired'
  | 'no-token'
  | 'invalid-token'
  | 'user-not-found'

/** Options for the {@link auth} middleware. */
export interface AuthOptions {
  /**
   * Custom response when authentication fails. Receives the request context
   * and the reason for the failure, mirroring `csrf()`'s `onFail` and
   * `rateLimit()`'s `onLimitReached`.
   *
   * Use this to shape the rejection to an app's error envelope. When unset,
   * `auth()` keeps its default `{ error: 'Unauthenticated' }` 401 body.
   *
   * @example
   * auth('session', {
   *   onFail: (ctx) =>
   *     ctx.json(
   *       { error_code: 'UNAUTHORIZED', message: 'You must be signed in.', details: null },
   *       401,
   *     ),
   * })
   */
  onFail?: (ctx: Context, reason: AuthFailureReason) => Response | Promise<Response>
}

/** Default 401 body, used when `onFail` is unset. Reason-independent. */
function defaultFailure(ctx: Context): Response {
  return ctx.json({ error: 'Unauthenticated' }, 401)
}

/**
 * Require the request to be authenticated.
 *
 * For the session guard, requires the `session()` middleware to run first
 * so that `ctx.get('session')` is available. Checks that the session has
 * a user associated with it.
 *
 * Sets:
 * - `ctx.get('user')` — the resolved user object
 * - `ctx.get('accessToken')` — the AccessTokenData (token guard only)
 *
 * On a failed check the middleware returns a `401`. Pass `onFail` to shape
 * that response to a custom error envelope; otherwise a default
 * `{ error: 'Unauthenticated' }` body is returned.
 *
 * The guard name and the options object are independent — pass either, both,
 * or neither. `auth({ onFail })` uses the default guard.
 *
 * @param guardOrOptions  guard name (`'session' | 'token'`, defaults to config
 *   `auth.default`) or, when the default guard is wanted, the options object.
 * @param options  options object, when a guard name is also given.
 *
 * @example
 * router.group({ middleware: [session(), auth()] }, (r) => { ... })
 * router.group({ middleware: [auth('token')] }, (r) => { ... })
 *
 * @example
 * // Shape the rejection to a structured error envelope.
 * auth('session', {
 *   onFail: (ctx) =>
 *     ctx.json(
 *       { error_code: 'UNAUTHORIZED', message: 'You must be signed in.', details: null },
 *       401,
 *     ),
 * })
 */
export function auth(guardOrOptions?: string | AuthOptions, options?: AuthOptions): Middleware {
  const guard = typeof guardOrOptions === 'string' ? guardOrOptions : undefined
  const opts = typeof guardOrOptions === 'string' ? options : guardOrOptions
  const { onFail } = opts ?? {}
  const fail = (ctx: Context, reason: AuthFailureReason): Response | Promise<Response> =>
    onFail ? onFail(ctx, reason) : defaultFailure(ctx)

  return async (ctx, next) => {
    const guardName = guard ?? Auth.config.default

    if (guardName === 'session') {
      const session = ctx.get<Session>('session')

      if (!session) return fail(ctx, 'no-session')
      if (!session.isAuthenticated) return fail(ctx, 'unauthenticated')
      if (session.isExpired()) return fail(ctx, 'session-expired')

      const user = await Auth.resolveUser(session.userId!)
      if (!user) return fail(ctx, 'user-not-found')

      ctx.set('user', user)

      const response = await next()
      await session.touch()
      return response
    }

    if (guardName === 'token') {
      const header = ctx.header('authorization')
      if (!header?.startsWith('Bearer ')) {
        return fail(ctx, 'no-token')
      }

      const accessToken = await AccessToken.validate(header.slice(7))
      if (!accessToken) return fail(ctx, 'invalid-token')

      const user = await Auth.resolveUser(accessToken.userId)
      if (!user) return fail(ctx, 'user-not-found')

      ctx.set('user', user)
      ctx.set('accessToken', accessToken)

      return next()
    }

    return ctx.json({ error: `Unknown auth guard: ${guardName}` }, 500)
  }
}
