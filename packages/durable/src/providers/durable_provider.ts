import { ServiceProvider } from '@strav/kernel'
import type { Application } from '@strav/kernel'
import { Durable } from '../durable.ts'

export interface DurableProviderOptions {
  /** Whether to auto-create the durable engine tables. Default: `true`. */
  ensureTables?: boolean
}

/**
 * Registers the durable execution engine.
 *
 * On boot it creates the engine tables and registers the `durable:advance` /
 * `durable:compensate` queue handlers. Run a `@strav/queue` `Worker` on the
 * durable queue (default name `'durable'`) to actually process runs.
 */
export default class DurableProvider extends ServiceProvider {
  readonly name = 'durable'
  override readonly dependencies = ['database', 'queue']

  constructor(private readonly options?: DurableProviderOptions) {
    super()
  }

  override async boot(_app: Application): Promise<void> {
    if (this.options?.ensureTables !== false) {
      await Durable.ensureTables()
    }
    Durable.registerHandlers()
  }
}
