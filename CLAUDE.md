# Strav Ecosystem

Bun monorepo. Run `bun install` from root.

## Structure
- packages/ — framework libraries (split into focused packages)
  - kernel — foundation: app lifecycle, IoC, config, events, exceptions, helpers, encryption, storage, cache, i18n, logger
  - view — template engine, Vue islands, SPA router, asset versioning
  - http — web layer: router, server, middleware, auth, sessions, validation, policies
  - database — persistence: query builder, ORM, schema, migrations
  - signal — communication: mail, notifications, broadcasting
  - queue — background: job processing, task scheduling
  - cli — developer tooling: CLI framework, code generators
  - auth, flag, stripe, devtools, mcp, machine, oauth2, brain, search, social, testing, workflow, rag
- apps/ — products (platform, vault)
- docs/ — ecosystem-wide documentation
- deprecated/ — archived, do not reference for active work

## Dependency Graph

### Framework core (split from former @strav/core)
```
kernel (0 deps)
  ├── http (→ kernel)
  ├── view (→ kernel, http)
  ├── database (→ kernel)
  ├── queue (→ kernel, database)
  ├── signal (→ kernel, http, view, database, queue)
  └── cli (→ kernel, http, database, queue, signal)
```

### Consumer packages
- auth → kernel
- flag → kernel, database, http, cli
- stripe → kernel, database, http
- devtools → kernel, http, database, cli
- mcp → kernel, http, cli
- machine → kernel, database
- oauth2 → kernel, http, database, cli
- brain → kernel, workflow
- search → kernel, database, cli
- social → kernel, http, database
- testing → kernel, http, view, database
- workflow → kernel
- rag → kernel, brain, database, cli

### Apps
- apps/vault — standalone (no framework dependency)

## Git Structure
True monorepo structure. All packages are now part of the main repository with unified git history.
All changes are committed directly to the main repository.

## Conventions
- All packages use @strav/ npm scope
- Use workspace:* for internal dependencies
- **Barrel exports:** Every package exposes its full public API from `src/index.ts`. Consumer packages must import from the root barrel (`from '@strav/kernel'`, not `from '@strav/kernel/core'`). Deep sub-path imports are reserved for internal cross-package use within the 7 core packages (kernel, view, http, database, queue, signal, cli).
- When adding a new public symbol, export it from the relevant sub-module `index.ts` so it flows up to the root barrel.
- extractUserId lives in @strav/database (exported via database barrel; implementation in database/helpers — it depends on BaseModel)
- HTTP middleware for cache/i18n/logger lives in @strav/http (exported via http barrel; implementation in http/middleware)
<!-- Add your conventions below -->
<!-- - Error handling: ... -->
<!-- - Naming: ... -->
<!-- - API design: ... -->

## Testing Database
Packages (packages/*) use the following credentials for testing. Apps (apps/*) manage their own database credentials.
```
DB_HOST=127.0.0.1
DB_PORT=5432
DB_USER=liva
DB_PASSWORD=password1234
DB_DATABASE=strav_testing
```

## Commands
- bun install — install all dependencies
- bun run typecheck — typecheck the entire workspace (must pass with 0 errors)
- bun test — run all tests
- bun test --filter @strav/kernel — test a specific package
- ./scripts/publish.sh — publish packages to npm with workspace:* fix (use --help for options)
- ./scripts/sync-patch-versions.sh — bump all packages to next patch version (0.7.2 → 0.7.3)
- ./scripts/sync-minor-versions.sh — bump all packages to next minor version (0.7.2 → 0.8.0)
- ./scripts/sync-major-versions.sh — bump all packages to next major version (0.7.2 → 1.0.0)

## Multi-tenant Database Support

### Schema Organization
Database schemas and migrations are separated by scope:
- `database/schemas/public/` — System-wide schemas (users, organizations, etc.)
- `database/schemas/tenants/` — Tenant-specific schemas (application data)
- `database/migrations/public/` — Migrations for public schema
- `database/migrations/tenants/` — Migrations for tenant schemas

### Migration Commands
Generate and run migrations with scope:
```bash
# Generate public schema migrations
bun strav generate:migration --scope=public --message="add user table"

# Generate tenant schema migrations
bun strav generate:migration --scope=tenants --message="add orders table"

# Run public migrations
bun strav migrate --scope=public

# Run tenant migrations (applies to all tenants)
bun strav migrate --scope=tenants

# Rollback migrations
bun strav rollback --scope=public
bun strav rollback --scope=tenants
```

### Migration Tracking
- Public migrations tracked in `_strav_migrations` table
- Tenant migrations tracked in `_strav_tenant_migrations` table

## Publishing
- **Command:** Run `./scripts/publish.sh` to publish packages to npm
- **Options:**
  - `--dry-run` — Test without actually publishing
  - `--package NAME` — Publish specific package(s), comma-separated
  - `--skip-check` — Skip npm login verification
  - `--help` — Show usage information
- **Examples:**
  - `./scripts/publish.sh` — Publish all packages
  - `./scripts/publish.sh --dry-run` — Test publishing process
  - `./scripts/publish.sh --package kernel` — Publish only kernel
  - `./scripts/publish.sh --package kernel,database,http` — Publish multiple packages
- **Issue:** `bun publish` does not correctly replace `workspace:*` with the current version being published
- **Solution:** The script temporarily replaces `workspace:*` with actual version numbers before publishing
- The script publishes packages in dependency order (kernel first, then dependent packages)
- Private packages are automatically skipped
- Already published versions are detected and skipped

## Rules
- When modifying kernel exports, check all packages for breaking changes
- When modifying http/database/queue/signal APIs, check consumer packages
- Never import from apps/ into packages/
- Dependency direction: apps → consumer packages → core packages (kernel, view, http, database, queue, signal, cli)
