import ServiceProvider from '@strav/kernel/core/service_provider'
import type Application from '@strav/kernel/core/application'
import Database from '../database/database'
import { BaseModel } from '../orm'
import TenantManager from '../database/tenant/manager'
import { ensureTenantTable } from '../database/tenant/seed'

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
      await ensureTenantTable(this.db.bypass, this.db.tenantIdType)
    }
  }

  override async shutdown(): Promise<void> {
    if (this.db) {
      await this.db.close()
      this.db = null
    }
  }
}
