import { ServiceProvider } from '@strav/kernel'
import type { Application } from '@strav/kernel'
import WebhookManager from '../webhook/webhook_manager.ts'

export interface WebhookProviderOptions {
  /** Auto-create the webhook tables. Default: `true`. */
  ensureTables?: boolean
  /** Auto-register the queue handler that processes delivery jobs. Default: `true`. */
  registerQueueHandler?: boolean
}

export default class WebhookProvider extends ServiceProvider {
  readonly name = 'webhook'
  override readonly dependencies = ['config', 'database', 'queue']

  constructor(private options?: WebhookProviderOptions) {
    super()
  }

  override register(app: Application): void {
    app.singleton(WebhookManager)
  }

  override async boot(app: Application): Promise<void> {
    app.resolve(WebhookManager)
    if (this.options?.ensureTables !== false) {
      await WebhookManager.ensureTables()
    }
    if (this.options?.registerQueueHandler !== false) {
      WebhookManager.registerQueueHandler()
    }
  }

  override shutdown(): void {
    WebhookManager.reset()
  }
}
