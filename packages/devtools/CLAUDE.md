# @strav/devtools

Application debugging and performance monitoring. Combines a request inspector with an APM dashboard. Captures requests, queries, exceptions, logs, and jobs. Serves a built-in SPA dashboard at `/_devtools`.

## Dependencies
- @strav/kernel (peer)
- @strav/http (peer)
- @strav/database (peer)
- @strav/cli (peer)

## Commands
- bun test
- bun run build

## Architecture
- src/devtools_manager.ts — main manager class
- src/devtools_provider.ts — service provider registration
- src/collectors/ — data collectors (requests, queries, logs, etc.)
- src/recorders/ — metric recorders for APM
- src/storage/ — collected data storage backends
- src/dashboard/ — SPA frontend served at /_devtools
- src/commands/ — CLI commands
- src/types.ts — type definitions
- src/errors.ts — package-specific errors

## Conventions
- Collectors capture individual entries, recorders aggregate metrics
- Dashboard is self-contained in src/dashboard/ — bundled as static assets
- Should only be enabled in development environments

## Dashboard mount default

`DevtoolsProvider.options.dashboard` is env-aware when unset: the dashboard mounts only when `app.env` is `local`/`development`/`test`. In any other environment (including `production` and unset, which defaults to `production`), the routes are NOT registered. Pass `dashboard: true` to opt-in for a non-dev environment (and provide a strict `guard`!) or `dashboard: false` to skip registration entirely. This is defense-in-depth on top of `dashboardAuth()` — the gate would still block requests if mounted, but not registering at all is one less attack surface.

## API rate limiting + access audit hook

`/_devtools/api/*` routes are rate-limited (120 requests / 60 s, keyed by client IP via the default `rateLimit()` extractor) and emit `devtools:access` Emitter events for every call. Wire the event to `@strav/audit` to track who hit the inspector:

```ts
import { Emitter } from '@strav/kernel'
import { audit } from '@strav/audit'

Emitter.on('devtools:access', e => {
  audit.by(e.actor ?? { type: 'system', id: 'unknown' })
    .on('devtools', e.path)
    .action('viewed')
    .meta({ method: e.method, ip: e.ip })
    .log()
})
```

Both the rate limit and the event emit are zero-cost when no listener is registered (the access middleware short-circuits via `Emitter.listenerCount`).

## Redaction
- `RequestCollector` (headers) and `LogCollector` (context) pipe captured payloads through `redact()` from `@strav/kernel` before storage. Default deny-list covers Authorization, Cookie, X-Api-Key, X-Auth-Token, X-Csrf-Token, Proxy-Authorization, password/token/secret/api_key fields, and common casing variants — see `packages/kernel/src/helpers/redact.ts`.
- Both collectors accept a `redactKeys: string[]` option that extends the default deny-list with app-specific names.
- Stack traces in `ExceptionCollector` are NOT redacted. Stack lines are free-form text; key-based redaction can't reach into them. Application code must avoid putting secrets in error messages.
