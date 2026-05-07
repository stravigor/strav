import type { Middleware, Context, Session } from '@strav/http'
import { CacheManager } from '@strav/kernel'
import type { CacheStore } from '@strav/kernel'
import type { CaptchaOptions, FailureReason, ChallengeName } from './types.ts'
import { DEFAULTS } from './types.ts'
import { verifyChallenge } from './challenges.ts'
import { consumeReplay } from './token.ts'

/**
 * Form/JSON guard. Place after `csrf()` and (optionally) after `rateLimit()`
 * so cheap rejections don't even attempt CAPTCHA verification.
 *
 * @example
 * router.post('/register', [
 *   rateLimit({ window: 60_000, max: 5 }),
 *   csrf(),
 *   captcha({ types: ['honeypot', 'pow'] }),
 * ], handler)
 */
export function captcha(options: CaptchaOptions = {}): Middleware {
  const types = (options.types ?? ['honeypot', 'pow']) as ChallengeName[]
  const honeypotField = options.honeypotField ?? DEFAULTS.honeypotField
  const tokenField = options.tokenField ?? DEFAULTS.tokenField
  const responseField = options.responseField ?? DEFAULTS.responseField

  // Lazy default — calling CacheManager.store at module-load would throw
  // when the captcha import lands before the container is wired.
  const resolveStore = (): CacheStore => options.store ?? CacheManager.store

  const useHoneypot = types.includes('honeypot')

  return async (ctx, next) => {
    if (options.skip?.(ctx)) return next()

    // Only guard state-changing methods. GET/HEAD shouldn't carry forms.
    if (['GET', 'HEAD', 'OPTIONS'].includes(ctx.method)) return next()

    const body = await readBody(ctx)

    if (useHoneypot) {
      const trap = body[honeypotField]
      if (typeof trap === 'string' && trap.trim() !== '') {
        return failure(ctx, 'honeypot_tripped', body, options)
      }
    }

    // If honeypot is the only requested type, we're done.
    const challengeTypes = types.filter(t => t !== 'honeypot')
    if (challengeTypes.length === 0) return next()

    const token = typeof body[tokenField] === 'string' ? (body[tokenField] as string) : ''
    if (!token) return failure(ctx, 'token_missing', body, options)

    const result = verifyChallenge(token, body[responseField], body)
    if (!result.ok) return failure(ctx, result.reason, body, options)

    if (!challengeTypes.includes(result.payload.t)) {
      // Token is valid but for a type this guard wasn't asked to accept —
      // could happen if a challenge was issued for a different form.
      return failure(ctx, 'token_invalid', body, options)
    }

    const fresh = await consumeReplay(resolveStore(), result.payload)
    if (!fresh) return failure(ctx, 'replayed', body, options)

    return next()
  }
}

/**
 * Read the parsed body without crashing on text/plain or empty bodies.
 * Returns `{}` so callers can index without null-checks.
 */
async function readBody(ctx: Context): Promise<Record<string, unknown>> {
  try {
    const body = await ctx.body<unknown>()
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

async function failure(
  ctx: Context,
  reason: FailureReason,
  body: Record<string, unknown>,
  options: CaptchaOptions
): Promise<Response> {
  if (options.onFailure) return options.onFailure(ctx, reason)

  if (wantsJson(ctx)) {
    return ctx.json({ errors: { _captcha: [reason] } }, 422)
  }

  // Form path: flash errors + old input, redirect back to the referer
  // (or root). Mirrors the convention used by `validate()` consumers.
  const session = ctx.get<Session | undefined>('session')
  if (session) {
    session.flash('errors', { _captcha: [reason] })
    session.flash('old', stripCaptchaFields(body, options))
    await session.save()
  }

  const referer = ctx.header('referer') ?? '/'
  return ctx.redirect(referer, 303)
}

function wantsJson(ctx: Context): boolean {
  const accept = ctx.header('accept') ?? ''
  if (accept.includes('application/json')) return true
  if (ctx.header('x-requested-with') === 'XMLHttpRequest') return true
  const contentType = ctx.header('content-type') ?? ''
  return contentType.includes('application/json')
}

function stripCaptchaFields(
  body: Record<string, unknown>,
  options: CaptchaOptions
): Record<string, unknown> {
  const out = { ...body }
  delete out[options.honeypotField ?? DEFAULTS.honeypotField]
  delete out[options.tokenField ?? DEFAULTS.tokenField]
  delete out[options.responseField ?? DEFAULTS.responseField]
  return out
}
