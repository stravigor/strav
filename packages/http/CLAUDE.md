# @strav/http

HTTP layer for the Strav framework — router, server, middleware, authentication, sessions, validation, and authorization policies.

## Dependencies
- @strav/kernel (peer)

## Commands
- bun test
- bun run typecheck

## Architecture
- src/http/ — Router, Server, Context, CORS, rate limiting, cookies
- src/session/ — Session manager and middleware
- src/validation/ — Validation engine and rules
- src/policy/ — Authorization policies
- src/auth/ — Authentication guards, access tokens, middleware (authenticate, guest, csrf)
- src/middleware/ — Middleware from other packages that depend on HTTP types:
  - http_cache.ts — Cache-Control/ETag middleware (from kernel/cache)
  - i18n.ts — Locale detection middleware (from kernel/i18n)
  - request_logger.ts — Request logging middleware (from kernel/logger)
- src/providers/ — HttpProvider, AuthProvider, SessionProvider

## Conventions
- Context implements kernel's RequestContext interface
- Middleware files for cache/i18n/logger live here because they depend on HTTP types
- Auth middleware is in src/auth/middleware/ (authenticate, guest, csrf)
- View functionality (templates, islands) lives in @strav/view package
