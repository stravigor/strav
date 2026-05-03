# @strav/social

OAuth 2.0 social authentication with a fluent, driver-based API. Built-in providers: Google, GitHub, Discord, Facebook, LinkedIn. Custom providers can be added via extend().

## Dependencies
- @strav/kernel (peer)
- @strav/http (peer)
- @strav/database (peer)

## Commands
- bun test
- bun run build

## Architecture
- src/social_manager.ts — main manager class
- src/social_provider.ts — service provider registration
- src/abstract_provider.ts — base class for social providers
- src/providers/ — provider implementations (Google, GitHub, Discord, Facebook, LinkedIn)
- src/social_account.ts — normalized social account data
- src/schema.ts — validation schemas
- src/types.ts — type definitions

## Conventions
- Social providers extend abstract_provider.ts
- Custom providers are added via extend() on the manager
- Social account data is normalized into a common shape regardless of provider

## Verified-email gate (security)

`SocialUser.emailVerified` is mandatory and reflects the provider's own assertion that the user owns the email. Per-provider mapping:

- Google / LinkedIn — `email_verified` claim from the OIDC userinfo response (default `false` if missing).
- Discord — `verified` field from `/users/@me` (default `false`).
- GitHub / Facebook — `true` whenever an email is returned, because both providers only expose verified emails (GitHub via `/user/emails` filtered on `verified === true`; Facebook never returns unverified addresses).
- Custom providers — populate from the provider's verification claim. Default to `false` if the provider does not expose one.

**Callers MUST check `socialUser.emailVerified === true` before using `socialUser.email` to look up an existing application user.** The OAuth callback flow that links a social account to an existing user by email is the canonical pre-takeover vector: an attacker who registers with the provider using a victim's email and an unverified address will otherwise be linked to the victim's account on first sign-in. `SocialAccount.findOrCreate()` deliberately does not enforce this check itself — it can't tell whether `user` was located by email match or supplied directly — so the contract lives at the call site.

The OAuth `state` parameter is non-optional (the previously-available `provider.stateless()` opt-out was removed because it silently disabled CSRF protection). `userFromToken()` remains stateless by design — it is for cases where the access token was obtained out-of-band (e.g., a mobile client that ran its own OAuth dance).

## Token-endpoint authentication

`getAccessToken()` defaults to `client_secret_basic` (HTTP Basic auth — RFC 6749 §2.3.1) so the client secret stays out of body-logging surfaces. Apps can override per-provider via `ProviderConfig.tokenEndpointAuthMethod: 'post'`. Facebook overrides the default to `'post'` because its Graph API token endpoint reads the secret from the body. Other built-in providers (Google, GitHub, Discord, LinkedIn) accept Basic.

## Token storage at rest

`SocialAccount.create()` and `updateTokens()` encrypt the access token and refresh token via `EncryptionManager` before they hit the database; `hydrate()` decrypts them on read. Encrypted values are stored with an `enc:v1:` sentinel prefix. Legacy plaintext rows (predating this change) are returned as-is by `hydrate()` — they migrate to ciphertext on the next `updateTokens()` call. Tests must initialize encryption (e.g., `EncryptionManager.useKey('test-key')` in `beforeEach`) before calling `create()` or `updateTokens()`.

## Audit hooks

`SocialAccount` mutations emit Emitter events so apps can wire `@strav/audit` (or any other observability sink) without forcing a hard dependency:

- `social_account:linked` — fired by `create()`. Payload: `{ accountId, userId, provider, providerId }`.
- `social_account:tokens_updated` — fired by `updateTokens()` (also indirectly by `findOrCreate()` on the existing-account path). Payload: `{ accountId, hasRefreshToken, expiresAt }` (raw token values are NOT included).
- `social_account:unlinked` — fired by `delete()`. Payload: `{ accountId }`.
- `social_account:unlinked_all` — fired by `deleteByUser()`. Payload: `{ userId }`.

All emits are fire-and-forget (`.catch(() => {})`); subscriber failures don't break account writes. Recommended audit-integration pattern:

```ts
import { Emitter } from '@strav/kernel'
import { audit } from '@strav/audit'

Emitter.on('social_account:tokens_updated', e => {
  audit.bySystem('social')
    .on('social_account', String(e.accountId))
    .action('tokens_updated')
    .meta({ hasRefreshToken: e.hasRefreshToken })
    .log()
})
```
