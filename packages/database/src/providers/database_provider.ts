import ServiceProvider from '@strav/kernel/core/service_provider'
import type Application from '@strav/kernel/core/application'
import { ConfigurationError } from '@strav/kernel/exceptions/errors'
import Database from '../database/database'
import { BaseModel } from '../orm'
import TenantManager from '../database/tenant/manager'
import { isTenantIdTypeConfigured } from '../database/tenant/id_type'

export default class DatabaseProvider extends ServiceProvider {
  readonly name = 'database'
  override readonly dependencies = ['config']

  private db: Database | null = null

  override register(app: Application): void {
    app.singleton(Database)
    app.singleton(TenantManager)
  }

  override async boot(app: Application): Promise<void> {
    this.db = app.resolve(Database)
    await this.db.init()
    new BaseModel(this.db)

    if (this.db.isMultiTenant) {
      // Guard against the silent fallback: when no schema with
      // `tenantRegistry: true` has been registered, the tenant id type
      // falls back to the framework default ('bigint'). The migration
      // step (which runs through the CLI's own schema-discovery path) may
      // have created the table with a different PK type — typically uuid —
      // and the RLS DDL we're about to emit would clash on the cast.
      if (!isTenantIdTypeConfigured()) {
        throw new ConfigurationError(
          'database.tenant.enabled is true but no schema with `tenantRegistry: true` ' +
            'has been registered. Add SchemaProvider before DatabaseProvider in your ' +
            'service providers, and define a tenant registry schema (or re-export ' +
            '`@strav/database/schemas/default_tenant`). See docs/database/multitenant.md.'
        )
      }
      // Install framework-internal sequences infrastructure (counter table +
      // strav_assign_tenanted_id trigger function). The tenant registry
      // table is created by normal migrations — register a schema with
      // `tenantRegistry: true` (or import the built-in default from
      // `@strav/database/schemas/default_tenant`).
      const manager = app.resolve(TenantManager)
      await manager.setup()
    }
  }

  override async shutdown(): Promise<void> {
    if (this.db) {
      await this.db.close()
      this.db = null
    }
  }
}
