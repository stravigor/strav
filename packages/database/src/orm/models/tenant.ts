import { DateTime } from 'luxon'
import BaseModel from '../base_model'
import { primary } from '../decorators'

/**
 * Built-in tenants registry.
 *
 * One row per tenant. Tenant-scoped tables reference `tenant.id` (or whatever
 * table name `database.tenant.tableName` resolves to) via their `<tableName>_id`
 * column. The application sets the active tenant via `withTenant(tenantId, ...)`
 * before executing tenant-scoped queries.
 *
 * The table itself is global (not tenant-scoped) — it lives in `public`,
 * has no RLS policy, and is administered through {@link TenantManager}.
 *
 * The class name stays `Tenant` regardless of the configured table name; the
 * runtime `tableName` getter resolves to `db.tenantTableName`. Users who
 * prefer to refer to the model by a different name can alias on import:
 * `import { Tenant as Workspace } from '@strav/database'`.
 */
export default class Tenant extends BaseModel {
  static override tenantScoped: boolean = false

  /** Resolves to `database.tenant.tableName` (default `'tenant'`). */
  static override get tableName(): string {
    return BaseModel.db.tenantTableName
  }

  @primary
  declare id: string

  declare slug: string
  declare name: string
  declare createdAt: DateTime
  declare updatedAt: DateTime
}
