import { expect, test, describe } from 'bun:test'
import { join } from 'node:path'
import Application from '@strav/kernel/core/application'
import Configuration from '@strav/kernel/config/configuration'
import ServiceProvider from '@strav/kernel/core/service_provider'
import SchemaProvider from '../src/providers/schema_provider'
import SchemaRegistry from '../src/schema/registry'
import {
  getTenantIdType,
  isTenantIdTypeConfigured,
} from '../src/database/tenant/id_type'
import { getTenantTableName } from '../src/database/tenant/naming'

/**
 * Minimal config provider so SchemaProvider's `dependencies = ['config']`
 * edge is satisfied without materialising a real `config/` directory.
 */
class StubConfigProvider extends ServiceProvider {
  readonly name = 'config'
  constructor(private config: Configuration) {
    super()
  }
  override register(app: Application): void {
    app.singleton(Configuration, () => this.config)
  }
}

const FIXTURES = join(import.meta.dir, 'fixtures', 'schemas')

describe('SchemaProvider', () => {
  test('discovers schemas from the provided path and registers SchemaRegistry as a singleton', async () => {
    const app = new Application()
    app.use(new StubConfigProvider(new Configuration({})))
    app.use(new SchemaProvider({ path: join(FIXTURES, 'no_tenant') }))
    await app.start({ signalHandlers: false })

    const registry = app.resolve(SchemaRegistry)
    expect(registry.has('widget')).toBe(true)
    // Same instance on subsequent resolves (singleton).
    expect(app.resolve(SchemaRegistry)).toBe(registry)
  })

  test('throws if the schemas directory does not exist', async () => {
    const app = new Application()
    app.use(new StubConfigProvider(new Configuration({})))
    app.use(new SchemaProvider({ path: join(FIXTURES, '__missing__') }))

    await expect(app.start({ signalHandlers: false })).rejects.toThrow(
      /Schemas directory not found/
    )
  })

  test('reads database.schemasPath from config when no constructor path is given', async () => {
    const config = new Configuration({})
    config.set('database.schemasPath', join(FIXTURES, 'no_tenant'))

    const app = new Application()
    app.use(new StubConfigProvider(config))
    app.use(new SchemaProvider())
    await app.start({ signalHandlers: false })

    expect(app.resolve(SchemaRegistry).has('widget')).toBe(true)
  })

  test('propagates tenant table name + idType from a tenantRegistry schema (uuid PK)', async () => {
    const app = new Application()
    app.use(new StubConfigProvider(new Configuration({})))
    app.use(new SchemaProvider({ path: join(FIXTURES, 'with_tenant') }))
    await app.start({ signalHandlers: false })

    expect(isTenantIdTypeConfigured()).toBe(true)
    expect(getTenantIdType()).toBe('uuid')
    expect(getTenantTableName()).toBe('workspace')
  })
})
