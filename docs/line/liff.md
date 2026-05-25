# LIFF

Server-side verification for LIFF (LINE Front-end Framework) — the embeddable webview you open from inside the LINE app for flows that don't fit in a chat bubble (multi-step onboarding, OAuth handoffs, longer forms).

`@strav/line` handles the **server side**: verifying ID tokens minted by `liff.getIDToken()` and access tokens minted by `liff.getAccessToken()`. The client-side LIFF SDK (`@line/liff`) is loaded in your webview as usual — this package doesn't try to wrap it.

## When to use

- The user is inside the LINE app, you opened a webview via `liff.openWindow(...)` or a Rich Menu URI action, and you need to know **which LINE user** is hitting your server.
- You want to call the LINE platform on the user's behalf from your backend (profile fetch, friend list) using their access token.

For OAuth login from a regular browser ("Sign in with LINE" on your marketing site), use `@strav/social`'s [LineProvider](../social/social.md) instead — different channel type, different flow.

## How it works

```
[LIFF webview]
  await liff.init({ liffId })
  const idToken = await liff.getIDToken()
        │
        │ POST { idToken }
        ▼
[your server]
  const claims = await LineManager.liff().verify(idToken)
  // claims.sub === LINE user ID
  // start your session, link to a user row, etc.
```

The verifier calls LINE's hosted `/oauth2/v2.1/verify` endpoint. LINE validates the JWT signature, expiry, and audience for us, returns the parsed claims. We then check the `aud` claim matches the configured channel ID.

We use the hosted endpoint (not local JWKS verification) because:

- It's the LINE-recommended default.
- It avoids in-process JWKS key caching and rotation logic.
- The latency is fine for an interactive webview login.

If you have a high-throughput use case where the round-trip becomes a bottleneck, swap in local JWKS verification at the call site — the rest of the flow doesn't depend on `LiffVerifier`.

## Setup

Configure in `config/line.ts`:

```typescript
export default {
  channelAccessToken: env('LINE_CHANNEL_ACCESS_TOKEN', ''),
  channelSecret: env('LINE_CHANNEL_SECRET', ''),
  liff: {
    channelId: env('LINE_LIFF_CHANNEL_ID', ''),
  },
}
```

`channelId` is the LIFF channel ID from the LINE Developers console (Providers → your provider → LIFF channel). It is **not** the messaging channel ID — they're distinct channels under the same provider.

Access the verifier through `LineManager`:

```typescript
import { LineManager } from '@strav/line'

const claims = await LineManager.liff().verify(idToken)
```

`LineManager.liff()` throws `ConfigurationError` if `line.liff.channelId` isn't set, so app code can fail fast at boot if LIFF is required.

## ID token verification

The primary call. Returns the parsed claims on success, throws `ExternalServiceError` on any failure (expired, wrong audience, malformed, etc.).

```typescript
import { LineManager, type LiffIdTokenClaims } from '@strav/line'

const claims: LiffIdTokenClaims = await LineManager.liff().verify(idToken)

claims.iss       // 'https://access.line.me'
claims.sub       // 'U1234abcdef…'   — LINE user ID
claims.aud       // your LIFF channelId
claims.exp       // epoch seconds
claims.iat       // epoch seconds
claims.nonce?    // present if you passed one via liff.init({ ..., nonce })
claims.amr?      // authentication method references (e.g. ['pwd', 'lineautologin'])
claims.name?     // present when 'profile' scope is granted
claims.picture?  // present when 'profile' scope is granted
claims.email?    // present when 'openid email' scope is granted (rare — requires LINE approval)
```

`claims.sub` is the stable LINE user ID — use it as your application-level identifier or as a FK to a `social_account` row.

## Access token verification

Use when you've received an access token from the webview and want to confirm it's bound to your channel before making a LINE API call on the user's behalf.

```typescript
const info = await LineManager.liff().verifyAccessToken(accessToken)
info.scope        // 'profile openid'
info.client_id    // your LIFF channelId — verified to match
info.expires_in   // remaining seconds
```

Throws `ExternalServiceError` if the token was issued for a different channel, has expired, or is malformed.

## End-to-end example

### Client side (LIFF webview)

```html
<script src="https://static.line-scdn.net/liff/edge/2/sdk.js"></script>
<script type="module">
  await liff.init({ liffId: 'YOUR_LIFF_ID' })
  if (!liff.isLoggedIn()) {
    liff.login()
  } else {
    const idToken = await liff.getIDToken()
    const res = await fetch('/liff/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ idToken }),
    })
    const { redirectTo } = await res.json()
    location.href = redirectTo
  }
</script>
```

### Server side

```typescript
import { Router } from '@strav/http'
import { LineManager } from '@strav/line'
import { ExternalServiceError } from '@strav/kernel'

router.post('/liff/session', async ctx => {
  const { idToken } = await ctx.request.json<{ idToken: string }>()

  let claims
  try {
    claims = await LineManager.liff().verify(idToken)
  } catch (err) {
    if (err instanceof ExternalServiceError) {
      return ctx.json({ error: 'Invalid LIFF token' }, 401)
    }
    throw err
  }

  // Find or create your application user keyed by LINE user ID.
  // (Pattern is exactly the same as @strav/social — call out to your own
  // user-linking code here.)
  const user = await findOrCreateUserByLineId(claims.sub, {
    displayName: claims.name,
    pictureUrl: claims.picture,
  })

  // Start a session — same plumbing as any other login.
  const session = ctx.get<Session>('session')
  session.set('userId', user.id)

  return ctx.json({ redirectTo: '/app' })
})
```

## Security notes

- **Always verify on the server.** A LIFF webview can be opened in an external browser via `liff.openWindow({ external: true })` — never trust the client-side `liff.getProfile()` for authorisation decisions.
- **`aud` is your channel ID.** LINE's hosted verify endpoint takes `client_id` as a parameter and uses it as the expected audience — so the check is implicit in the call. `verifyAccessToken` performs the same check explicitly.
- **ID token vs access token.** Treat ID tokens as proof-of-identity (use `sub`); treat access tokens as bearer credentials for the LINE platform API (use to call `/v2/profile`, etc.). Don't store either in a cookie — store your own session ID and keep the LINE tokens in server-side storage.
- **Nonce replay protection.** If your flow involves a callback chain (e.g. LIFF → external service → back), generate a `nonce` on the server before opening LIFF, pass it through `liff.init({ ..., nonce })`, and check `claims.nonce` matches on return.

## Testing

`LineManager.useLiff(verifier)` swaps the LIFF verifier for a fake — useful for integration tests that simulate a logged-in LIFF session.

```typescript
import { LineManager, LiffVerifier } from '@strav/line'

class FakeLiffVerifier extends LiffVerifier {
  override async verify(token: string) {
    if (token === 'TEST_TOKEN') {
      return {
        iss: 'https://access.line.me',
        sub: 'U_test_user',
        aud: 'TEST_CHANNEL',
        exp: Date.now() / 1000 + 3600,
        iat: Date.now() / 1000,
        name: 'Test User',
      }
    }
    throw new Error('Unexpected test token')
  }
}

beforeEach(() => {
  LineManager.useLiff(new FakeLiffVerifier({ channelId: 'TEST_CHANNEL' }))
})
```

The built-in tests mock `globalThis.fetch` directly and assert against the form-encoded body sent to LINE's verify endpoint — see `packages/line/tests/liff_verifier.test.ts`.

## Differences from LINE Login

| | LIFF | LINE Login (`@strav/social`) |
|---|---|---|
| Channel type | LIFF channel | LINE Login channel |
| User context | Already in the LINE app | Any browser |
| Initiator | `liff.init()` in your webview | OAuth redirect to `https://access.line.me/oauth2/v2.1/authorize` |
| Token your server receives | ID token + access token (from JS) | Authorization code → exchanged for ID + access token |
| Use case | In-app onboarding, account-linked actions inside the LINE app | "Sign in with LINE" on your marketing or admin site |

The two flows can coexist — the same human user maps to the same `sub`, so account linking is straightforward across both surfaces.
