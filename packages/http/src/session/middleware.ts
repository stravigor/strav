import type { Middleware } from '../http/middleware.ts'
import { withCookie } from '../http/cookie.ts'
import Session from './session.ts'
import SessionManager from './session_manager.ts'

/**
 * Session middleware — attaches a Session to every request.
 *
 * 1. Reads the session cookie and loads the session from DB
 * 2. Creates a new anonymous session if absent or expired
 * 3. Ages flash data so previous-request flash is readable
 * 4. Sets `ctx.get('session')` and `ctx.get('csrfToken')`
 * 5. After the handler: saves dirty data and refreshes the cookie
 *
 * @example
 * import { session } from '@strav/http/session'
 * router.use(session())
 */
export function session(): Middleware {
  return async (ctx, next) => {
    let sess = await Session.fromRequest(ctx)

    if (!sess || sess.isExpired()) {
      sess = Session.create(ctx)
    }

    sess.ageFlash()

    ctx.set('session', sess)
    ctx.set('csrfToken', sess.csrfToken)

    const response = await next()

    await sess.save()

    // Refresh cookie (sliding expiration)
    const cfg = SessionManager.config
    return withCookie(response, cfg.cookie, sess.id, {
      httpOnly: cfg.httpOnly,
      secure: cfg.secure,
      sameSite: cfg.sameSite,
      maxAge: cfg.lifetime * 60,
      path: '/',
      domain: cfg.domain,
    })
  }
}
