# @strav/kernel

Foundation of the Stravigor ecosystem. Provides the Application lifecycle, IoC container, dependency injection, configuration, events, and core utilities. Every other package depends on this.

## Consumed by
All packages: http, database, signal, queue, cli, auth, flag, stripe, devtools, mcp, machine, oauth2, brain, search, social, testing, workflow.

## Commands
- bun test
- bun run typecheck

## Architecture
- src/core/ — Application, Container, ServiceProvider, inject
- src/config/ — Configuration loader (env, TypeScript)
- src/events/ — Event emitter
- src/exceptions/ — Error hierarchy (StravError, HttpException, ConfigurationError, ExceptionHandler)
- src/helpers/ — Utilities (strings, env, crypto, compose)
- src/encryption/ — Encrypt/decrypt manager
- src/storage/ — File storage abstraction (Local, S3, Ostra drivers)
- src/cache/ — Cache manager and drivers (in-memory)
- src/i18n/ — Internationalization manager
- src/logger/ — Logger with sinks (console, file)
- src/providers/ — ConfigProvider, EncryptionProvider, StorageProvider, CacheProvider, I18nProvider, LoggerProvider

## Conventions
- Each module is self-contained in its own directory
- Public API is exported through each module's index.ts
- Error types extend StravError or HttpException from src/exceptions/
- ExceptionHandler uses a RequestContext interface (not http Context directly) to avoid circular deps

## Important
- Changes to exports affect the entire ecosystem — test all dependent packages
- The RequestContext interface in exceptions is implemented by @strav/http's Context
- identity.ts (extractUserId) lives in @strav/database, not here
- HTTP middleware for cache/i18n/logger lives in @strav/http, not here
