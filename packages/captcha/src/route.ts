import type { Router, Context } from '@strav/http'
import { rateLimit } from '@strav/http'
import { issueChallenge } from './challenges.ts'
import { listChallengeTypes } from './registry.ts'
import type { ChallengeName } from './types.ts'

/**
 * Mount a refresh endpoint at `<prefix>/:type` so client-side widgets
 * (e.g. the SVG refresh button) can request a new challenge without a
 * full page reload. Stateless, no session required.
 *
 * Auto-rate-limited per IP — 30 issuances/minute by default. Override
 * by passing your own `rateLimit()` middleware in `extraMiddleware`,
 * or set `rateLimit: false` to disable (not recommended in production).
 *
 * @example
 * mountCaptchaRoutes(router)
 * // → GET /__captcha/svg, GET /__captcha/pow
 */
export function mountCaptchaRoutes(
  router: Router,
  options: {
    prefix?: string
    rateLimit?: false | { window?: number; max?: number }
    extraMiddleware?: ReturnType<typeof rateLimit>[]
  } = {}
): void {
  const prefix = options.prefix ?? '/__captcha'

  const middleware = []
  if (options.extraMiddleware?.length) {
    middleware.push(...options.extraMiddleware)
  } else if (options.rateLimit !== false) {
    middleware.push(
      rateLimit({
        window: options.rateLimit?.window ?? 60_000,
        max: options.rateLimit?.max ?? 30,
      })
    )
  }

  router.group({ prefix, middleware }, r => {
    r.get('/:type', async (ctx: Context) => {
      const type = ctx.params.type as ChallengeName
      if (!listChallengeTypes().includes(type)) {
        return ctx.json({ error: 'Unknown challenge type' }, 404)
      }

      const issued = issueChallenge(type)

      // SVG type returns the image directly — easy <img src=…> embed.
      // Other types return JSON so the client can hydrate its own widget.
      if (type === 'svg' && issued.html) {
        return new Response(issued.html, {
          status: 200,
          headers: {
            'Content-Type': 'image/svg+xml',
            'Cache-Control': 'no-store',
            // Pass the token via header so the client can stash it without
            // re-parsing the SVG body. Browsers expose this on fetch responses.
            'X-Captcha-Token': issued.token,
          },
        })
      }

      return ctx.json({
        token: issued.token,
        props: issued.props,
        html: issued.html,
      })
    })
  })
}
