import { app } from '@strav/kernel'
import { Router } from '@strav/http'
// `session` middleware is exported from the http session sub-barrel.
import { session } from '@strav/http/session/middleware'
import { createMagicLinkURL, verifyMagicLinkFromContext } from '@strav/http/auth/bridge'
import Session from '@strav/http/session/session'
import { mail } from '@strav/signal'

/**
 * Minimal app fixture for browser tests. Wires up:
 *   - GET  /ping              — sanity check, returns { ok: true }
 *   - POST /auth/magic        — issues a magic link via mail
 *   - GET  /auth/verify       — verifies the token and signs the user in
 *   - GET  /dashboard         — gated; renders a Newsreader-styled <h1>
 *
 * Apps using BrowserTestCase pass a `bootstrap` callback that calls this.
 * The fixture deliberately avoids any provider stack — the BrowserTestCase
 * lifecycle has already set up Configuration, Router, Auth, and Session.
 */
export async function registerFixtureRoutes(): Promise<void> {
  const router = app.resolve(Router)

  // Apply session middleware globally.
  router.use(session())

  router.get('/ping', ctx => ctx.json({ ok: true }))

  router.post('/auth/magic', async ctx => {
    const body = (await ctx.body()) as { email?: string } | null
    const email = body?.email
    if (!email) return ctx.json({ error: 'email required' }, 400)

    // Use the in-memory user id derived from the email so tests stay deterministic.
    const userId = `user:${email}`
    const link = createMagicLinkURL(`${ctx.url.origin}/auth/verify`, userId, { email })

    await mail
      .to(email)
      .subject('Sign in to the demo')
      .text(`Click here to sign in: ${link}`)
      .send()

    return ctx.json({ sent: true })
  })

  router.get('/auth/verify', async ctx => {
    const payload = verifyMagicLinkFromContext(ctx)
    if (!payload) return ctx.text('Invalid or expired token', 400)

    const sess = ctx.get<Session>('session')
    if (sess) sess.authenticate(String(payload.sub))

    return ctx.redirect('/dashboard')
  })

  router.get('/dashboard', ctx => {
    const sess = ctx.get<Session>('session')
    if (!sess?.isAuthenticated) return ctx.text('Unauthorized', 401)

    return ctx.html(`
      <!doctype html>
      <html>
        <head>
          <style>
            h1.welcome { font-family: 'Newsreader', serif; font-size: 32px; color: rgb(184, 68, 44); }
            p.lede::first-letter { font-size: 56px; color: rgb(184, 68, 44); }
            .codeblock pre code { font-family: monospace; }
            .callout .callout-icon { display: inline-block; }
          </style>
        </head>
        <body>
          <h1 class="welcome">Dashboard</h1>
          <p class="lede">Welcome to the editorial reader.</p>
          <div class="codeblock"><pre><code>const greeting = 'hello'</code></pre></div>
          <div class="callout"><span class="callout-icon">!</span> tip</div>
        </body>
      </html>
    `)
  })
}
