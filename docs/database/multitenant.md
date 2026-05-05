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
    idType:  'bigint',                          // 'bigint' (default) or 'uuid'
    bypass: {
      username: env('DB_BYPASS_USER', 'strav_admin'),    // BYPASSRLS role
      password: env('DB_BYPASS_PASSWORD', ''),
    },
  },
}
```

### Choosing an `idType`

| Value      | `tenant.id` PK                                | Tenanted child `tenant_id` |
| ---------- | --------------------------------------------- | -------------------------- |
| `'bigint'` (default) | `BIGSERIAL NOT NULL`                | `BIGINT NOT NULL`          |
| `'uuid'`   | `UUID NOT NULL DEFAULT gen_random_uuid()`     | `UUID NOT NULL`            |

Pick `'bigint'` for sequential server-generated IDs (smaller storage,
faster index lookups, no leakage of tenant count). Pick `'uuid'` if
tenants are created by external/distributed sources or you expose tenant
IDs publicly and want unguessable values.

The same `idType` is threaded through schema generation, migration SQL,
the RLS policy cast, and the runtime validator in `withTenant(...)`.
Once a database is provisioned it cannot be changed without a data
migration — pick deliberately at install time.

> **Migrating from v0.4.x.** Apps previously running on v0.4.x have
> UUID-based tenant tables. Set `idType: 'uuid'` explicitly to keep them
> working — the framework default flipped to `'bigint'` in v0.5.0.

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
