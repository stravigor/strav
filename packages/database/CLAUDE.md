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
- Tenant-scoped tables carry `<tenantFk> <idType> NOT NULL DEFAULT current_setting('app.tenant_id', true)::<idType> REFERENCES <tenantTable>(id) ON DELETE CASCADE`. The tenant table name and idType are derived from the schema marked `tenantRegistry: true` — its `name` becomes the table name (FK column auto-derives as `<name>_id`); its PK pgType (`serial`/`bigserial`/`smallserial`/`uuid`) maps to a runtime cast (`integer`/`bigint`/`integer`/`uuid`). Built-in default re-exportable from `@strav/database/schemas/default_tenant`. `SchemaRegistry.register()` propagates name + idType into module state on registration; `Database` getters read from there. Threaded through `RepresentationBuilder`, `SqlGenerator`, the policy/seed DDL helpers, and the trigger function (reads `NEW.<TG_ARGV[0]>` dynamically). `database.tenant.idType` and `database.tenant.tableName` config keys are gone — Database throws if either is set.
- `Database` exposes two pools when `database.tenant.enabled` is true:
  - **app** pool — non-superuser role (NOBYPASSRLS), used for `db.sql`. In a `withTenant(...)` block the SQL client is wrapped to inject `set_config('app.tenant_id', $1, true)` as the first statement of every transaction.
  - **bypass** pool — `database.tenant.bypass.username` (BYPASSRLS role), used by migrations, `TenantManager`, and `withoutTenant(...)`. Lazy-initialised, accessible via `db.bypass`.
- `withTenant(uuid, fn)` / `withoutTenant(fn)` are AsyncLocalStorage-based and propagate through async boundaries.
- `BaseModel.tenantScoped = true` makes `save()` throw if called outside a tenant or bypass context.
- `defineSchema(name, { tenanted: true, fields })` adds the column + RLS policy DDL automatically. The injected column name is `<tenantTableName>_id` (e.g. `workspace_id` when `tableName: 'workspace'`).
- `BaseModel.load('<tenantTableName>')` populates the parent tenant row from the configured table; override with `static tenantRef` for a custom accessor name.
- `MigrationRunner` always runs against `db.bypass` so policies don't filter the migration itself.
- `t.tenantedSerial()` / `t.tenantedBigSerial()` give per-tenant id sequences (each tenant counts 1, 2, 3, … independently). Composite PK `(tenant_id, id)`; references from other tenanted tables are auto-promoted to composite FKs `(tenant_id, parent_id) → parent(tenant_id, id)`. Backed by a global `_strav_tenant_sequences` table + `strav_assign_tenanted_id()` trigger function installed by `TenantManager.setup()`. See `docs/database/multitenant.md` § Per-tenant ID sequences.
