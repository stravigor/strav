import { ServiceProvider } from '@strav/kernel'
import type { Application } from '@strav/kernel'
import BroadcastManager from '../broadcast/broadcast_manager.ts'
import type { BootOptions } from '../broadcast/broadcast_manager.ts'
import { Router } from '@strav/http'

export default class BroadcastProvider extends ServiceProvider {
  readonly name = 'broadcast'

  constructor(private options?: BootOptions) {
    super()
  }

  override boot(app: Application): void {
    const router = app.resolve(Router)
    BroadcastManager.boot(router, this.options)
  }

  override shutdown(): void {
    BroadcastManager.reset()
  }
}
