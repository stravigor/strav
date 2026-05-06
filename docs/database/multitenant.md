# Multi-Tenant Database Support

`@strav/database` ships native multi-tenancy backed by PostgreSQL **row-level
security** (RLS). All tenants share one database, one schema, and one set
of migrations; isolation is enforced by the database itself, not by
WHERE clauses scattered through application code.

## Why RLS

The previous schema-per-tenant approach worked but was heavy: per-tenant
schemas, per-tenant migrations, schema cloning, model prefixes per domain.
The RLS approach replaces all of that with two columns and one policy:

- Every tenant-scoped table carries a `tenant_id` column. Type is
  configurable via `database.tenant.idType` — defaults to `'bigint'`,
  also supports `'uuid'`.
- An RLS policy filters rows where `tenant_id = current_setting('app.tenant_id')::<idType>`.
- The application sets `app.tenant_id` once per request, inside a
  transaction, via `set_config('app.tenant_id', $1, true)`.
- PostgreSQL refuses to return — and refuses inserts that target — rows
  belonging to other tenants. No app-level filtering required.

The application connects as a non-superuser role so policies are enforced.
Migrations and admin tasks use a second role with the `BYPASSRLS` attribute.

## Configuration

```typescript
// config/database.ts
export default {
  host:     env('DB_HOST', '127.0.0.1'),
  port:     env.int('DB_PORT', 5432),
  database: env('DB_DATABASE', 'myapp'),
  username: env('DB_USER', 'strav_app'),       // NOBYPASSRLS role
  password: env('DB_PASSWORD', ''),

  tenant: {
    enabled: true,
    bypass: {
      username: env('DB_BYPASS_USER', 'strav_admin'),    // BYPASSRLS role
      password: env('DB_BYPASS_PASSWORD', ''),
    },
  },
}
```

The tenant table name and primary-key type are **not** in config. The
framework reads both from the schema you mark `tenantRegistry: true`.

### Defining the tenant registry

Add a schema marked `tenantRegistry: true`. The schema's *name* becomes
the tenant table; the schema's *PK type* drives every cast and FK column
type across the tenanted children.

```typescript
// database/schemas/workspace.ts
import { defineSchema, t, Archetype } from '@strav/database'

export default defineSchema('workspace', {
  archetype: Archetype.Entity,
  tenantRegistry: true,
  fields: {
    id:   t.bigserial().primaryKey(),  // or t.serial() / t.uuid()
    slug: t.string().unique().required(),
    name: t.string().required(),
  },
})
```

If you don't want a custom layout, re-export the built-in default
(`tenant` table, `BIGSERIAL` PK, plus `slug` and `name`):

```typescript
// database/schemas/tenant.ts
export { default } from '@strav/database/schemas/default_tenant'
```

Exactly one schema across the registry may set `tenantRegistry: true`.
At least one is required when any other schema is marked `tenanted: true`.

### Supported PK types

| `t.…().primaryKey()` | Storage column      | Cast in DEFAULT / RLS policy | FK on tenanted children |
| -------------------- | ------------------- | ----------------------------- | ----------------------- |
| `t.serial()`         | `SERIAL`            | `::integer`                   | `INTEGER NOT NULL`      |
| `t.smallserial()`    | `SMALLSERIAL`       | `::integer`                   | `INTEGER NOT NULL`      |
| `t.bigserial()`      | `BIGSERIAL`         | `::bigint`                    | `BIGINT NOT NULL`       |
| `t.uuid()`           | `UUID DEFAULT gen_random_uuid()` | `::uuid`         | `UUID NOT NULL`         |

Pick `t.serial()` / `t.bigserial()` for sequential server-generated IDs
(smaller storage, faster index lookups). Pick `t.uuid()` if tenants are
created by external/distributed sources or if you expose tenant IDs
publicly and want unguessable values. Stick with `t.bigserial()` if you
expect more than ~2 billion tenants; `t.serial()` is a safe pick for
practically any app where that ceiling won't be hit.

The PK type is set once at install — switching it later requires a data
migration. Pick deliberately.

### Renaming the tenant table

Rename the schema. The framework derives every related identifier from
the schema's name:

| Concept                                  | With `tenant`     | With `workspace`               |
| ---------------------------------------- | ----------------- | ------------------------------ |
| Tenant registry table                    | `tenant`          | `workspace`                    |
| FK column on tenanted children           | `tenant_id`       | `workspace_id`                 |
| Composite PK on tenantedSerial tables    | `(tenant_id, id)` | `(workspace_id, id)`           |
| Composite FK to a tenantedSerial parent  | `(tenant_id, …)`  | `(workspace_id, …)`            |
| RLS policy column                        | `tenant_id`       | `workspace_id`                 |
| `model.load('<name>')` accessor          | `'tenant'`        | `'workspace'`                  |

The session config key (`app.tenant_id`) and the framework-internal
`_strav_tenant_sequences` counter table are *not* renamed — they're
implementation details that have no user-facing meaning. The dynamic
`strav_assign_tenanted_id()` trigger function still reads
`NEW.<configured FK column>` correctly.

The class name of the built-in `Tenant` model stays put — TypeScript
class names can't be config-driven. Alias on import if you prefer:

```typescript
import { Tenant as Workspace } from '@strav/database'

const ws = await Workspace.find(id)
```

**Renaming on a live database is a one-shot manual migration:** rename
the table, the FK columns on every tenanted child, and recreate the RLS
policies and triggers. The diff engine refuses to auto-detect the
rename.

**Validation.** The schema name is interpolated directly into DDL, so it
must be a plain snake_case identifier (lowercase letters, digits, and
underscores; cannot start with a digit).

> **Migrating from earlier versions.** The `database.tenant.idType` and
> `database.tenant.tableName` config keys are removed. Define a
> `tenantRegistry: true` schema instead — Database now throws a helpful
> error at boot if either key is set.

## Database Roles

You need two PostgreSQL roles:

| Role           | Attribute     | Used by                                              |
| -------------- | ------------- | ---------------------------------------------------- |
| `strav_app`    | `NOBYPASSRLS` | Application queries (RLS enforced)                   |
| `strav_admin`  | `BYPASSRLS`   | Migrations, `TenantManager`, `withoutTenant(...)`    |

Generate the SQL:

```bash
bun strav db:setup-roles
```

Or apply directly (requires a superuser):

```bash
bun strav db:setup-roles --apply --superuser=postgres
```

The command emits something like:

```sql
CREATE ROLE "strav_app" LOGIN PASSWORD '...' NOBYPASSRLS;
CREATE ROLE "strav_admin" LOGIN PASSWORD '...' BYPASSRLS;
GRANT ALL ON DATABASE "myapp" TO "strav_app", "strav_admin";
GRANT ALL ON SCHEMA public TO "strav_app", "strav_admin";
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON TABLES TO "strav_app", "strav_admin";
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL ON SEQUENCES TO "strav_app", "strav_admin";
```

## Defining Tenant-Scoped Tables

Mark a schema as `tenanted`. The schema builder injects a `tenant_id`
column and the migration generator emits the RLS policy DDL automatically.

```typescript
// database/schemas/order.ts
import { defineSchema, t } from '@strav/database'

export default defineSchema('order', {
  tenanted: true, // ← tenant_id column + RLS policy
  fields: {
    total: t.decimal(10, 2).required(),
    status: t.enum(['pending', 'paid']).default('pending'),
  },
})
```

Generated migration (with `idType: 'bigint'`, the default):

```sql
CREATE TABLE IF NOT EXISTS "order" (
  "id" SERIAL,
  "tenant_id" BIGINT NOT NULL DEFAULT current_setting('app.tenant_id', true)::bigint,
  "total" DECIMAL(10,2) NOT NULL,
  "status" "order_status" NOT NULL DEFAULT 'pending',
  ...
  CONSTRAINT "pk_order" PRIMARY KEY ("id"),
  CONSTRAINT "fk_order_tenant_id" FOREIGN KEY ("tenant_id")
    REFERENCES "tenant"("id") ON DELETE CASCADE
);

ALTER TABLE "order" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "order"
  USING ("tenant_id" = current_setting('app.tenant_id', true)::bigint)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::bigint);
```

With `idType: 'uuid'` the column becomes `UUID` and the cast becomes
`::uuid` everywhere — same shape, different type.

Tell the model it's tenant-scoped so `save()` refuses to run outside a
context:

```typescript
import { BaseModel, primary } from '@strav/database'

export default class Order extends BaseModel {
  static override tenantScoped = true

  @primary
  declare id: number

  declare total: number
  declare status: 'pending' | 'paid'
}
```

## Setting Tenant Context

`withTenant(id, callback)` runs the callback inside an async context that
the SQL proxy reads on every query. The `id` is always a string — pass a
numeric string for `'bigint'` or a UUID literal for `'uuid'`. Format is
validated against the configured `idType` before any SQL is bound.

```typescript
import { withTenant } from '@strav/database'

// idType: 'bigint' (default)
await withTenant('1234', async () => {
  const orders = await Order.all()             // only this tenant's rows
  await Order.create({ total: 99.0 })          // tenant_id auto-fills
})

// idType: 'uuid'
await withTenant('a3b1c4d5-...', async () => { /* ... */ })
```

Under the hood every query becomes a transaction whose first statement is
`SELECT set_config('app.tenant_id', $1, true)` — the `true` makes the
setting transaction-local so it cannot leak between callers via the
connection pool.

## HTTP Middleware Example

```typescript
// app/middleware/tenant.ts
import { withTenant, TenantManager } from '@strav/database'
import type { Middleware } from '@strav/http'

export const tenantMiddleware: Middleware = async (ctx, next) => {
  const host = ctx.request.headers.get('host') ?? ''
  const slug = host.split('.')[0]

  const manager = ctx.container.resolve(TenantManager)
  const tenant = slug ? await manager.findBySlug(slug) : null

  if (!tenant) return ctx.text('Unknown tenant', 404)
  return withTenant(tenant.id, () => next())
}
```

```typescript
// app/middleware/admin.ts
import { withoutTenant } from '@strav/database'
import type { Middleware } from '@strav/http'

export const bypassTenant: Middleware = (_ctx, next) => withoutTenant(() => next())
```

## Loading the parent tenant from a model

A tenant-scoped model can load its parent row through `model.load(...)`.
The relation name defaults to the configured tenant table name — so with
`tableName: 'workspace'`, `await project.load('workspace')` populates
`project.workspace` with the matching `Workspace` row. Override per-model
with `static tenantRef = 'whatever'` if you need a different accessor.

```typescript
class Project extends BaseModel {
  static tenantScoped = true
  // optional override; defaults to db.tenantTableName
  // static tenantRef = 'workspace'
}

const project = await Project.find(1)
await project.load('workspace')
project.workspace // populated tenant row
```

The lookup routes through the bypass connection (the tenant table has no
RLS), so it works inside `withTenant(...)` or `withoutTenant(...)`.

## Tenant Management

The built-in `Tenant` registry lives in `public` (not RLS-scoped). All
methods on `TenantManager` route through the bypass connection.

```typescript
import { TenantManager } from '@strav/database'

const manager = container.resolve(TenantManager)

const tenant = await manager.create({ slug: 'acme', name: 'Acme Corp' })
await manager.list()
await manager.findBySlug('acme')
await manager.find(tenant.id)
await manager.exists(tenant.id)
await manager.getStats(tenant.id)
await manager.delete(tenant.id) // cascades via FK
```

Or via CLI:

```bash
bun strav tenant:create --slug=acme --name="Acme Corp"
bun strav tenant:list
bun strav tenant:delete <id>     # numeric for bigint, UUID for uuid
```

## Background Jobs

Restore the tenant context inside the worker before doing any DB work:

```typescript
async function processInvoiceJob(job: Job) {
  await withTenant(job.payload.tenantId, async () => {
    await Order.find(job.payload.orderId)
  })
}
```

## Migrations

Single tracking table (`_strav_migrations`) and single migration directory
(`database/migrations/`). The runner connects via the bypass pool so RLS
policies do not filter the migration itself.

```bash
bun strav generate:migration --message="add orders table"
bun strav migrate
bun strav rollback
bun strav rollback --batch=3
bun strav fresh   # drops everything and re-runs (APP_ENV=local only)
```

## Transactions

`transaction()` participates in the active tenant context — the first
statement of every transaction becomes
`SELECT set_config('app.tenant_id', $1, true)`.

```typescript
await withTenant(tenantId, async () => {
  await transaction(async trx => {
    const order = await Order.create({ total: 50 }, trx)
    await Item.create({ orderId: order.id }, trx)
  })
})
```

## Per-tenant ID sequences

`t.tenantedSerial()` and `t.tenantedBigSerial()` give each tenant its own
ID counter. Within a tenant, IDs go `1, 2, 3, …`; across tenants the
identity space is fully partitioned. Globally unique identity is the
composite `(tenant_id, id)`.

Use this when tenants expect human-readable, low-numbered identifiers
(invoice numbers, order numbers, ticket numbers) instead of cluster-wide
SERIAL values.

```typescript
export default defineSchema('order', {
  tenanted: true,
  fields: {
    id:    t.tenantedBigSerial().primaryKey(),  // BIGINT, per-tenant counter
    total: t.decimal(10, 2).required(),
  },
})
```

Generated DDL (with `idType: 'bigint'`):

```sql
CREATE TABLE "order" (
  "id"        BIGINT NOT NULL,
  "tenant_id" BIGINT NOT NULL DEFAULT current_setting('app.tenant_id', true)::bigint,
  "total"     DECIMAL(10,2) NOT NULL DEFAULT 0,
  ...
  CONSTRAINT "pk_order" PRIMARY KEY ("tenant_id", "id")
);

ALTER TABLE "order" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "order" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "order" ...;

CREATE TRIGGER "order_assign_tenanted_id"
  BEFORE INSERT ON "order" FOR EACH ROW
  EXECUTE FUNCTION strav_assign_tenanted_id();
```

### How it works

- A global `_strav_tenant_sequences` table tracks `(tenant_id, table_name) → next_value`
  and is itself RLS-protected so each tenant only sees its own counters.
- One global PL/pgSQL function `strav_assign_tenanted_id()` runs as a
  BEFORE INSERT trigger. If `NEW.id IS NULL`, it UPSERTs the counter row
  and writes `NEW.id`. The UPSERT row-locks `(tenant_id, table_name)` so
  concurrent inserts in the same tenant serialize on that lock; tenants
  never block each other.
- Both the table and the function are installed once at boot via
  `TenantManager.setup()` (idempotent). Per-table triggers are emitted
  by the migration generator alongside `CREATE TABLE`.

### Constraints and trade-offs

- **Composite primary key.** PK is `(tenant_id, id)`. Within a tenant
  context (`withTenant(...)`) this is invisible to callers — RLS scopes
  every query to the active tenant, so `Model.find(1)` returns *that
  tenant's* row 1.
- **Composite foreign keys.** A reference to a tenantedSerial parent is
  emitted as `FOREIGN KEY (tenant_id, parent_id) → parent(tenant_id, id)`.
  The child must itself be `tenanted: true` so the child has a `tenant_id`
  column to reuse; otherwise `defineSchema` throws. Composite FKs always
  use `ON DELETE CASCADE` because `SET NULL` is impossible on a
  `NOT NULL tenant_id`.
- **Gap-free per committed transaction.** The counter increment lives in
  the caller's transaction, so a rolled-back insert reclaims its number.
  Postgres SERIAL does *not* roll back. Gaps still appear on explicit
  DELETEs.
- **Explicit ids pass through.** If you `INSERT ... (id, ...) VALUES (100, ...)`,
  the trigger leaves `NEW.id` alone. The counter is unaware of 100, so a
  later auto-issued id may eventually collide and fail with a PK
  violation — same model as Postgres SERIAL.
- **Initial creation only.** Migrating an existing column between
  `serial` and `tenantedSerial` is intentionally rejected by the differ;
  drop and recreate the column manually.
- **`Model.find(id)` requires a tenant context.** A tenant-scoped model
  (`tenantScoped = true`) throws if you call `find` outside
  `withTenant(...)` / `withoutTenant(...)`, mirroring the existing
  guard on `save()`.

### When *not* to use it

- High-throughput inserts within a single tenant — the row-level lock
  on `_strav_tenant_sequences` serializes per-tenant writes. For very
  hot tenants, prefer regular `t.bigserial()` (no per-tenant lock) or
  UUID PKs.
- When external systems already own the IDs (use `t.uuid()` or
  `t.bigserial()` and let the source assign).
- For tables that don't need user-facing numbering — the extra
  composite-PK and composite-FK machinery is only worth it when you
  actually need 1, 2, 3 per tenant.

## Bypass

`withoutTenant(callback)` routes through the BYPASSRLS connection. Use
sparingly and only from server-side admin paths.

```typescript
import { withoutTenant, sql } from '@strav/database'

await withoutTenant(async () => {
  const totals = await sql`
    SELECT tenant_id, COUNT(*) AS orders
    FROM "order"
    GROUP BY tenant_id
  `
})
```

## Security Model

1. **Database-enforced.** RLS is applied by PostgreSQL at the executor
   level. No app-level WHERE clause means no app-level mistake can leak
   data.
2. **`FORCE ROW LEVEL SECURITY`.** Even the table owner is filtered, so
   accidentally connecting as the wrong role still respects policies.
3. **Tx-local setting.** `set_config(..., true)` only persists for the
   transaction. There is no risk of a previous request's tenant leaking
   to the next caller via a shared pooled connection.
4. **WITH CHECK.** Inserts and updates targeting a different tenant
   are rejected at the database, not silently filtered.
5. **Typed cast.** The setting is cast to the configured `idType`
   inside the policy (e.g. `current_setting('app.tenant_id', true)::bigint`),
   so a malformed value raises a SQL error rather than matching anything
   by accident. The runtime validator in `withTenant(...)` rejects
   malformed IDs even earlier — before they reach Postgres.

## API Reference

### Context

- `withTenant(tenantId, callback)` — run inside a tenant context
- `withoutTenant(callback)` — run with the BYPASSRLS connection
- `getCurrentTenantId()` — current tenant id (numeric string or UUID, depending on `idType`) or `null`
- `hasTenantContext()` — true if `withTenant(...)` is active and not bypassed
- `isBypassingTenant()` — true if `withoutTenant(...)` is active

### TenantManager

- `setup()` — ensure the `tenant` table exists
- `create({ slug, name })` — insert and return the new tenant
- `delete(id)` — delete and cascade tenant-scoped rows
- `list()` — all tenants ordered by `created_at`
- `find(id)` / `findBySlug(slug)` / `exists(id)` — lookups
- `getStats(id)` — `{ tables, totalRows }`

### Schema builder

- `defineSchema(name, { tenanted: true, fields, ... })` — emit a tenant-scoped table

### BaseModel

- `static tenantScoped: boolean` — declare a model tenant-scoped
- `save()` — throws `DatabaseError` if `tenantScoped` and no context
