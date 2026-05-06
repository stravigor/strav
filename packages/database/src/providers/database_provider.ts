import ServiceProvider from '@strav/kernel/core/service_provider'
import type Application from '@strav/kernel/core/application'
import Database from '../database/database'
import { BaseModel } from '../orm'
import TenantManager from '../database/tenant/manager'

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
    new BaseModel(this.db)

    if (this.db.isMultiTenant) {
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
