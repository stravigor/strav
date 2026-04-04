import type { Middleware } from '../../http/middleware.ts'
import Auth from '../auth.ts'
import type Session from '../../session/session.ts'
import AccessToken from '../access_token.ts'

/**
 * Only allow unauthenticated requests through.
 *
 * For the session guard, requires the `session()` middleware to run first
 * so that `ctx.get('session')` is available.
 *
 * Useful for login/register pages that should not be accessible to
 * users who are already logged in.
 *
 * @param redirectTo  If provided, authenticated users are redirected here
 *                    instead of receiving a 403.
 *
 * @example
 * router.group({ middleware: [session(), guest('/dashboard')] }, (r) => {
 *   r.get('/login', showLoginPage)
 * })
 */
export function guest(redirectTo?: string): Middleware {
  return async (ctx, next) => {
    const guardName = Auth.config.default
    let isAuthenticated = false

    if (guardName === 'session') {
      const session = ctx.get<Session>('session')
      isAuthenticated = session && session.isAuthenticated && !session.isExpired()
    } else if (guardName === 'token') {
      const header = ctx.header('authorization')
      if (header?.startsWith('Bearer ')) {
        const accessToken = await AccessToken.validate(header.slice(7))
        isAuthenticated = accessToken !== null
      }
    }

    if (isAuthenticated) {
      if (redirectTo) return ctx.redirect(redirectTo)
      return ctx.json({ error: 'Already authenticated' }, 403)
    }

    return next()
  }
}
