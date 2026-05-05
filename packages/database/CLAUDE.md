# @strav/database

Database layer for the Strav framework — query builder, ORM, schema builder, and migrations.

## Dependencies
- @strav/kernel (peer)

## Commands
- bun test
- bun run typecheck

## Architecture
- src/database/ — Database connections, query builder, migrations, introspector, seeder
  - src/database/tenant/ — Multi-tenant (RLS) context, TenantManager, RLS policy helpers
  - src/database/migration/ — Migration system (single `_strav_migrations` tracker)
- src/orm/ — BaseModel, decorators, query builder re-export
  - src/orm/models/tenant.ts — Built-in `Tenant` registry model
- src/schema/ — Schema builder (field definitions, type builder, associations)
- src/helpers/ — identity.ts (extractUserId — moved here from kernel because it depends on BaseModel)
- src/providers/ — DatabaseProvider (also seeds the `tenant` table when `tenant.enabled`)

## Conventions
- database and orm are tightly coupled (circular dependency) — they stay together
- extractUserId lives here in src/helpers/identity.ts, not in kernel
- String helpers (toSnakeCase, toCamelCase) are imported from @strav/kernel/helpers

## Multi-tenant (RLS) Support
- One database, one schema, one migrations directory.
- Tenant-scoped tables carry `tenant_id <idType> NOT NULL DEFAULT current_setting('app.tenant_id', true)::<idType> REFERENCES tenant(id) ON DELETE CASCADE`. `idType` is `'bigint'` by default; set `database.tenant.idType: 'uuid'` to opt into UUID instead. Threaded through `RepresentationBuilder`, `SqlGenerator`, RLS policy DDL helpers in `policies.ts`, and the runtime validator in `tenant/context.ts`.
- `Database` exposes two pools when `database.tenant.enabled` is true:
  - **app** pool — non-superuser role (NOBYPASSRLS), used for `db.sql`. In a `withTenant(...)` block the SQL client is wrapped to inject `set_config('app.tenant_id', $1, true)` as the first statement of every transaction.
  - **bypass** pool — `database.tenant.bypass.username` (BYPASSRLS role), used by migrations, `TenantManager`, and `withoutTenant(...)`. Lazy-initialised, accessible via `db.bypass`.
- `withTenant(uuid, fn)` / `withoutTenant(fn)` are AsyncLocalStorage-based and propagate through async boundaries.
- `BaseModel.tenantScoped = true` makes `save()` throw if called outside a tenant or bypass context.
- `defineSchema(name, { tenanted: true, fields })` adds the column + RLS policy DDL automatically.
- `MigrationRunner` always runs against `db.bypass` so policies don't filter the migration itself.
