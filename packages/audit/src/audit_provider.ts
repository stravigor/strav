import { ServiceProvider } from '@strav/kernel'
import type { Application } from '@strav/kernel'
import AuditManager from './audit_manager.ts'

export interface AuditProviderOptions {
  /** Auto-create the audit log table. Default: `true`. */
  ensureTable?: boolean
}

export default class AuditProvider extends ServiceProvider {
  readonly name = 'audit'
  override readonly dependencies = ['config', 'database', 'encryption']

  constructor(private options?: AuditProviderOptions) {
    super()
  }

  override register(app: Application): void {
    app.singleton(AuditManager)
  }

  override async boot(app: Application): Promise<void> {
    app.resolve(AuditManager)
    if (this.options?.ensureTable !== false) {
      await AuditManager.ensureTable()
    }
  }

  override shutdown(): void {
    AuditManager.reset()
  }
}
