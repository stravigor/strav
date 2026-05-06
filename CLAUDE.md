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

Multi-tenancy uses PostgreSQL row-level security (RLS) with a `tenant_id`
column on each tenant-scoped table. One database, one schema, one set of
migrations. Full guide: `docs/database/multitenant.md`.

### How it works
- Mark a table `tenanted: true` in `defineSchema(...)`. The schema builder
  injects `<tenantFk> <idType> NOT NULL DEFAULT current_setting('app.tenant_id', true)::<idType>`
  with FK to `<tenantTable>(id) ON DELETE CASCADE`. `idType` is `'bigint'`
  by default; set `database.tenant.idType: 'uuid'` for UUID. The tenant
  table is named `tenant` by default; set `database.tenant.tableName: 'workspace'`
  to rename it (FK column auto-derives as `<tableName>_id`).
- The migration generator emits `ENABLE`/`FORCE ROW LEVEL SECURITY` and a
  `tenant_isolation` policy with the matching `::<idType>` cast.
- `withTenant(id, fn)` wraps `fn`'s queries in transactions whose first
  statement is `SELECT set_config('app.tenant_id', $1, true)`. The id is
  validated against the configured `idType` (numeric string or UUID).
- `withoutTenant(fn)` routes through a separate connection bound to a role
  with `BYPASSRLS` (used by migrations and `TenantManager`).
- `t.tenantedSerial()` / `t.tenantedBigSerial()` give each tenant its own
  id sequence (1, 2, 3, … per tenant). Composite PK `(tenant_id, id)`;
  cross-table references auto-promote to composite FKs. Backed by a
  global `_strav_tenant_sequences` counter table + `strav_assign_tenanted_id()`
  trigger installed by `TenantManager.setup()`.

### Configuration
```typescript
// config/database.ts
export default {
  username: env('DB_USER', 'strav_app'),       // NOBYPASSRLS role
  tenant: {
    enabled:   true,
    idType:    'bigint',                        // 'bigint' (default) or 'uuid'
    tableName: 'tenant',                        // default; rename to 'workspace', etc.
    bypass: {
      username: env('DB_BYPASS_USER', 'strav_admin'),  // BYPASSRLS role
      password: env('DB_BYPASS_PASSWORD', ''),
    },
  },
}
```

### Commands
```bash
bun strav db:setup-roles --apply       # provision app + bypass roles
bun strav generate:migration -m "msg"  # one tracker table, no --scope
bun strav migrate
bun strav rollback [--batch=N]
bun strav fresh                        # APP_ENV=local only
bun strav tenant:create --slug=acme --name="Acme Corp"
bun strav tenant:list
bun strav tenant:delete <uuid>
```

### Migration tracking
- Single `_strav_migrations` table, run via the bypass connection.

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
