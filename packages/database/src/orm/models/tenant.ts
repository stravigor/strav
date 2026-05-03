import { DateTime } from 'luxon'
import BaseModel from '../base_model'
import { primary } from '../decorators'

/**
 * Built-in tenants registry.
 *
 * One row per tenant. Tenant-scoped tables reference `tenant.id` via their
 * `tenant_id` column. The application sets the active tenant via
 * `withTenant(tenantId, ...)` before executing tenant-scoped queries.
 *
 * The table itself is global (not tenant-scoped) — it lives in `public`,
 * has no RLS policy, and is administered through {@link TenantManager}.
 */
export default class Tenant extends BaseModel {
  static override tenantScoped: boolean = false

  @primary
  declare id: string

  declare slug: string
  declare name: string
  declare createdAt: DateTime
  declare updatedAt: DateTime
}
