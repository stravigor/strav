import ServiceProvider from '@strav/kernel/core/service_provider'
import type Application from '@strav/kernel/core/application'
import Configuration from '@strav/kernel/config/configuration'
import SchemaRegistry from '../schema/registry'

export interface SchemaProviderOptions {
  /**
   * Filesystem path to the directory containing schema `.ts` files. Each
   * file must default-export a `SchemaDefinition`. Resolved relative to the
   * process working directory.
   *
   * Resolution order:
   *   1. This option, if provided.
   *   2. `database.schemasPath` config key, if set.
   *   3. `'./database/schemas'` (framework default).
   */
  path?: string
}

/**
 * Discovers all `defineSchema(...)` definitions in the project and
 * registers them with a shared {@link SchemaRegistry}. Must boot before
 * {@link DatabaseProvider} so that the schema marked `tenantRegistry: true`
 * propagates its name + PK type into module state — otherwise
 * `DatabaseProvider`'s tenant setup emits RLS DDL against the framework
 * default `'bigint'` and clashes with whatever the migrations actually
 * created.
 *
 * @example
 * app.useProviders([
 *   new ConfigProvider(),
 *   new SchemaProvider(),
 *   new DatabaseProvider(),
 * ])
 */
export default class SchemaProvider extends ServiceProvider {
  readonly name = 'schema'
  override readonly dependencies = ['config']

  constructor(private options: SchemaProviderOptions = {}) {
    super()
  }

  override register(app: Application): void {
    app.singleton(SchemaRegistry)
  }

  override async boot(app: Application): Promise<void> {
    const config = app.resolve(Configuration)
    const path =
      this.options.path ?? config.get('database.schemasPath') ?? './database/schemas'
    const registry = app.resolve(SchemaRegistry)
    await registry.discover(path)
    registry.validate()
  }
}
