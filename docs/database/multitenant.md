# Multi-Tenant Database Support

`@strav/database` ships native multi-tenancy backed by PostgreSQL **row-level
security** (RLS). All tenants share one database, one schema, and one set
of migrations; isolation is enforced by the database itself, not by
WHERE clauses scattered through application code.

## Why RLS

The previous schema-per-tenant approach worked but was heavy: per-tenant
schemas, per-tenant migrations, schema cloning, model prefixes per domain.
The RLS approach replaces all of that with two columns and one policy:

- Every tenant-scoped table carries a `tenant_id UUID` column.
- An RLS policy filters rows where `tenant_id = current_setting('app.tenant_id')::uuid`.
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

Generated migration includes:

```sql
CREATE TABLE IF NOT EXISTS "order" (
  "id" SERIAL,
  "tenant_id" UUID NOT NULL DEFAULT current_setting('app.tenant_id', true)::uuid,
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
  USING ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);
```

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

`withTenant(uuid, callback)` runs the callback inside an async context that
the SQL proxy reads on every query.

```typescript
import { withTenant } from '@strav/database'

await withTenant('a3b1c4d5-...', async () => {
  // RLS sees app.tenant_id = 'a3b1c4d5-...'
  const orders = await Order.all()             // only this tenant's rows
  await Order.create({ total: 99.0 })          // tenant_id auto-fills
})
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
bun strav tenant:delete <uuid>
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
5. **Cast to UUID.** The setting is cast to UUID inside the policy
   (`current_setting('app.tenant_id', true)::uuid`), so a malformed value
   raises an error rather than matching anything by accident.

## API Reference

### Context

- `withTenant(tenantId, callback)` — run inside a tenant context
- `withoutTenant(callback)` — run with the BYPASSRLS connection
- `getCurrentTenantId()` — current UUID or `null`
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
