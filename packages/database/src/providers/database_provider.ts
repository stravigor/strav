import ServiceProvider from '@strav/kernel/core/service_provider'
import type Application from '@strav/kernel/core/application'
import Database from '../database/database'
import { BaseModel } from '../orm'

export default class DatabaseProvider extends ServiceProvider {
  readonly name = 'database'
  override readonly dependencies = ['config']

  private db: Database | null = null

  override register(app: Application): void {
    app.singleton(Database)
  }

  override boot(app: Application): void {
    this.db = app.resolve(Database)
    new BaseModel(this.db)
  }

  override async shutdown(): Promise<void> {
    if (this.db) {
      await this.db.close()
      this.db = null
    }
  }
}
