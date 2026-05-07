# CAPTCHA

`@strav/captcha` is the framework's built-in CAPTCHA — a drop-in alternative to reCAPTCHA, hCaptcha, and Turnstile that doesn't require a third-party account, doesn't phone home, and doesn't track your users. It ships three challenge types out of the box, layers them through a single middleware, and renders them with a `@captcha` view directive that mirrors `@csrf`.

## Quick start

```bash
bun add @strav/captcha
```

```typescript
// start/routes.ts
import { router, rateLimit, csrf } from '@strav/http'
import { captcha, mountCaptchaRoutes, installCaptchaHelpers } from '@strav/captcha'

mountCaptchaRoutes(router) // exposes GET /__captcha/:type for refresh
installCaptchaHelpers()    // wires the @captcha view directive

router.post('/register', [
  rateLimit({ window: 60_000, max: 5 }),
  csrf(),
  captcha({ types: ['honeypot', 'pow'] }),
], registerHandler)
```

```blade
{{-- resources/views/auth/register.strav --}}
<form method="post" action="/register">
  @csrf('input')
  @captcha('pow')
  <input name="email" type="email" required>
  <button type="submit">Sign up</button>
</form>
```

That's it. The honeypot field traps naive form-fillers, the proof-of-work island makes scripted submission costly, and the middleware blocks anything that doesn't satisfy both before your handler ever runs.

## Why built-in?

External CAPTCHA services solve the problem at the cost of:

- **A billing relationship** — Google reCAPTCHA, Cloudflare Turnstile, and hCaptcha all want a registered site key.
- **A privacy footprint** — every form view exfiltrates IP and browser fingerprint to a third party.
- **A failure mode you don't control** — when their service degrades, your sign-up flow breaks.

Strav's CAPTCHA is built on primitives the framework already ships: signed tokens (`encrypt.seal`/`unseal`), the pluggable cache (`CacheManager.store`), composable middleware, the validation pipeline, and Vue islands. No new dependencies, no new infrastructure to operate, and the security model is auditable end-to-end.

## Challenge types

### Honeypot

A hidden form field humans never see. Bots that auto-fill every input on the page trip it. Free, zero UX, and should always be layered with another type as a baseline.

```typescript
captcha({ types: ['honeypot'] })
```

### Proof of work

A hashcash-style challenge: the client must find a nonce N such that `sha256(salt + ':' + N)` has at least `difficulty` leading zero bits. Verification is a single hash on the server. The Vue island spawns a Web Worker so the page stays responsive while solving.

```typescript
captcha({ types: ['honeypot', 'pow'], difficulty: 18 })
```

| Difficulty | Mobile (1–4 cores) | Desktop |
|------------|--------------------|---------|
| 16 bits    | 50–250 ms          | 20–100 ms |
| 18 bits    | 200–800 ms         | 100–500 ms (default) |
| 20 bits    | 800–3000 ms        | 400–1500 ms |

PoW is invisible to assistive tech and adds no friction for a real user — but it raises the cost of automated submission by orders of magnitude. Pair with rate-limiting for compounding effect.

### Distorted SVG text

A 6-character code rendered as inline SVG with per-glyph rotation, baseline jitter, and decoy strokes — no canvas library, no font files, no external assets. The user retypes it.

```typescript
captcha({ types: ['honeypot', 'svg'] })
```

```blade
<form method="post">
  @csrf('input')
  @captcha('svg')
  <button type="submit">Submit</button>
</form>
```

The directive emits the SVG inline, a refresh button (Vue island that calls `GET /__captcha/svg`), and a text input named `_captcha_answer`.

> **Defense level**: better than no CAPTCHA, far weaker than reCAPTCHA. The point is to make scripted bulk submission expensive, not to stop a targeted attacker who'll route to a human solver. Layer with PoW for compounding cost.

## How verification works

Every challenge produces a sealed token (`encrypt.seal`) that the form embeds in a hidden `_captcha` field. On submit:

1. The middleware unseals the token. Tampering, bad seal, or expired ⇒ rejected.
2. The challenge type's `verify()` checks the user's response against the payload — for SVG, that's `sha256(answer.lower().trim() + salt)` matched timing-safely against `payload.ah`. For PoW, it's a leading-zero-bits count on the digest.
3. On success, the token's `jti` is marked used in the cache (`CacheManager.store`). Replay attempts on the same token are rejected.

The token is **stateless** — the server doesn't store anything at issue time, only at successful verify. Failed attempts touch nothing (rate-limit middleware handles flood protection).

```typescript
interface CaptchaTokenPayload {
  v: 1                    // version
  t: 'honeypot' | 'pow' | 'svg'
  ah?: string             // sha256(answer.lower().trim() + salt)
  s: string               // 16-byte hex salt (also the PoW challenge)
  d?: number              // PoW difficulty bits
  iat: number             // issued-at, ms
  exp: number             // expiry minutes
  jti: string             // 16-byte hex — replay key
}
```

## API

### `captcha(options?)` middleware

```typescript
interface CaptchaOptions {
  types?: ChallengeName[]      // default: ['honeypot', 'pow']
  honeypotField?: string       // default: 'website'
  tokenField?: string          // default: '_captcha'
  responseField?: string       // default: '_captcha_answer'
  difficulty?: number          // PoW bits, default 18
  ttlMinutes?: number          // default 10
  skip?: (ctx: Context) => boolean
  onFailure?: (ctx: Context, reason: FailureReason) => Response | Promise<Response>
  store?: CacheStore           // default: CacheManager.store
}
```

The middleware is no-op on `GET`/`HEAD`/`OPTIONS` — it only guards state-changing requests.

### `issueChallenge(type, opts?)` / `verifyChallenge(token, response, body?)`

The middleware is the recommended path, but the primitives are exported if you want to embed a CAPTCHA in a stateless API or a custom flow:

```typescript
import { issueChallenge, verifyChallenge } from '@strav/captcha'

const issued = issueChallenge('pow', { difficulty: 16 })
// → { token: '<sealed>', props: { challenge, difficulty }, html?: '<svg…>' }

const result = verifyChallenge(token, response)
if (!result.ok) console.log(result.reason)
```

Note: `verifyChallenge` does **not** consume the replay slot — the middleware does. If you call it directly you should call `consumeReplay(store, payload)` yourself on success.

### `@captcha` view directive

```blade
@captcha           {{-- honeypot field only --}}
@captcha('pow')    {{-- honeypot + token + Vue PoW island --}}
@captcha('svg')    {{-- honeypot + token + inline SVG + answer input --}}
```

The directive calls a `__captcha(variant)` helper on the view scope, which `installCaptchaHelpers()` registers via `ViewEngine.setGlobal()`. Customize the field names with `configureCaptchaHelper({ honeypotField, tokenField, responseField })`.

> **The directive only runs in `.strav` templates** — Vue's compiler interprets `@` as event-binding syntax, so it can't be used inside a `.vue` `<template>`. If your form lives inside a Vue island, render the `<form>` and the captcha fields in the parent `.strav` template and scope the Vue island to just the inputs that need reactivity:
>
> ```blade
> {{-- resources/views/auth/login.strav --}}
> <form method="post" action="/api/auth/login">
>   @csrf('input')
>   <vue:auth/login-fields />   {{-- v-model state, validation feedback --}}
>   @captcha('svg')
>   <button type="submit">Sign in</button>
> </form>
> ```
>
> The Vue island handles the parts that need client-side state; `@csrf` and `@captcha` stay outside it where the directive runs.

### Validation rule

For handlers that prefer `validate()` integration over middleware:

```typescript
import { captchaRule } from '@strav/captcha'
import { validate, required, email } from '@strav/http'

const body = await ctx.body<Record<string, unknown>>()
const { errors } = validate(body, {
  _captcha: [captchaRule(body._captcha_answer, body)],
  email: [required(), email()],
})
```

The rule does **not** perform replay prevention (`validate()` is sync and has no place to read the cache). Use the rule for idempotent endpoints; use the middleware everywhere else.

### Refresh route

`mountCaptchaRoutes(router, options?)` exposes `GET /__captcha/:type`:

- For `svg`: returns the SVG body with `Content-Type: image/svg+xml`. The new sealed token is in the `X-Captcha-Token` response header.
- For `pow` (and any other type): returns `{ token, props }` JSON.

The route is auto-rate-limited (30/min/IP). Override with `mountCaptchaRoutes(router, { rateLimit: { window: 60_000, max: 60 } })` or pass your own middleware via `extraMiddleware`.

## Failure UX

By default the middleware mirrors existing patterns:

- **JSON requests** (`Accept: application/json`, `X-Requested-With: XMLHttpRequest`, or JSON content-type) get **422** with `{ errors: { _captcha: [reason] } }` — same shape as `validate()`.
- **Form requests with a session** flash `errors._captcha` and `old` (the submitted body), then redirect to `Referer` (303).
- Override with `onFailure(ctx, reason)` for custom responses.

```typescript
type FailureReason =
  | 'token_missing' | 'token_invalid' | 'token_expired'
  | 'answer_mismatch' | 'replayed'
  | 'honeypot_tripped' | 'pow_insufficient'
  | 'unknown_type'
```

## Multi-instance deployments

The default `MemoryCacheStore` is per-process. In a multi-instance deployment, replay prevention is only effective if every instance shares a cache — otherwise a token consumed on one node can be replayed on another within its TTL window.

**Production**: configure a shared cache store before the captcha middleware runs.

```typescript
import { CacheManager } from '@strav/kernel'
import { RedisCacheStore } from '@strav/database'

CacheManager.useStore(new RedisCacheStore(redis))
```

The captcha package uses whatever `CacheManager.store` resolves to at request time, so the store registration just needs to happen at boot (in a service provider or `start/bootstrap.ts`).

## Custom challenge types

The registry is open. Implement the `ChallengeType` interface and register it:

```typescript
import { registerChallengeType } from '@strav/captcha'

registerChallengeType({
  name: 'math',
  issue({ salt }) {
    const a = Math.floor(Math.random() * 10)
    const b = Math.floor(Math.random() * 10)
    return {
      props: { question: `What is ${a} + ${b}?` },
      answer: String(a + b),
    }
  },
  verify(payload, response) {
    if (typeof response !== 'string') return { ok: false, reason: 'answer_mismatch' }
    // payload.ah was set by the framework from the `answer` you returned
    const expected = hashAnswer(response, payload.s)
    return safeEqual(expected, payload.ah!) ? { ok: true } : { ok: false, reason: 'answer_mismatch' }
  },
})
```

`hashAnswer` and `safeEqual` are exported from `@strav/captcha` — use them so your verification matches what the framework hashed at issue time.

## Security notes

- **Tokens are AES-GCM encrypted** with the app's `APP_KEY` (via `encrypt.seal`). Tampering, replay across keys, or unsealing in another app all fail.
- **Honeypot is layered**, not standalone. A bot that knows the field name can submit cleanly — the PoW or SVG check is what makes scripted abuse expensive.
- **Don't lower PoW difficulty below 14 bits.** It becomes essentially free for scripts, and the UX gain on weak hardware is marginal (≤50 ms).
- **No-JS fallback**: PoW requires JavaScript. For `<noscript>` flows, configure `types: ['honeypot', 'svg']`.
- **Accessibility**: the SVG ships with `aria-label="Type the characters shown"` and a refresh button. PoW is invisible to assistive tech (zero friction). Audio captcha is not provided in v1 — when you need a non-visual challenge, prefer registering a math word problem (see *Custom challenge types* above).

## See also

- [HTTP](../http/http.md) — middleware, sessions, validation pipeline.
- [View](../view/view.md) — `@csrf` and the directive system that `@captcha` plugs into.
- Source: [`packages/captcha`](../../packages/captcha).
