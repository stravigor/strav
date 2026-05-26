import { expect, test, describe } from 'bun:test'
import Application from '@strav/kernel/core/application'
import Configuration from '@strav/kernel/config/configuration'
import ServiceProvider from '@strav/kernel/core/service_provider'
import DatabaseProvider from '../src/providers/database_provider'
import { isTenantIdTypeConfigured } from '../src/database/tenant/id_type'

/**
 * Regression guard for upstream note 002. `DatabaseProvider.boot()` used
 * to silently fall back to the default tenant id type (`bigint`) when no
 * `tenantRegistry: true` schema had been registered — which mismatched
 * the actual table's PK type whenever the user configured a UUID tenant
 * registry. Now boot throws a clear error directing the user at
 * `SchemaProvider`.
 *
 * Each Bun test file runs in its own subprocess, so the module-level
 * `configured` flag in `tenant/id_type.ts` starts at `false` here without
 * any explicit reset.
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

describe('DatabaseProvider tenant guard', () => {
  test('starts in the unconfigured state (Bun process isolation sanity check)', () => {
    expect(isTenantIdTypeConfigured()).toBe(false)
  })

  test('throws when tenant.enabled is true but no tenant schema has been registered', async () => {
    const config = new Configuration({})
    config.set('database.tenant.enabled', true)
    // Set a bypass user so we don't trip the bypass-credentials check
    // before the guard fires (we never get to actually opening a pool).
    config.set('database.tenant.bypass.username', 'noop')

    const app = new Application()
    app.use(new StubConfigProvider(config))
    app.use(new DatabaseProvider())

    await expect(app.start({ signalHandlers: false })).rejects.toThrow(
      /no schema with `tenantRegistry: true` has been registered/
    )
  })
})
