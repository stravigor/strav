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

## Redaction
- `RequestCollector` (headers) and `LogCollector` (context) pipe captured payloads through `redact()` from `@strav/kernel` before storage. Default deny-list covers Authorization, Cookie, X-Api-Key, X-Auth-Token, X-Csrf-Token, Proxy-Authorization, password/token/secret/api_key fields, and common casing variants — see `packages/kernel/src/helpers/redact.ts`.
- Both collectors accept a `redactKeys: string[]` option that extends the default deny-list with app-specific names.
- Stack traces in `ExceptionCollector` are NOT redacted. Stack lines are free-form text; key-based redaction can't reach into them. Application code must avoid putting secrets in error messages.
