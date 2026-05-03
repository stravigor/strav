import { Configuration, ServiceProvider } from '@strav/kernel'
import type { Application } from '@strav/kernel'
import type { Context } from '@strav/http'
import { Router } from '@strav/http'
import DevtoolsManager from './devtools_manager.ts'
import { registerDashboard } from './dashboard/routes.ts'

export interface DevtoolsProviderOptions {
  /** Auto-create the devtools tables. Default: `true` */
  ensureTables?: boolean
  /** Auto-register the request-tracking middleware on the router. Default: `true` */
  middleware?: boolean
  /**
   * Auto-register the dashboard routes at `/_devtools`. When unset
   * (default), the dashboard mounts only when `app.env` is
   * `'local'`, `'development'`, or `'test'`. Pass `true` to mount in
   * any environment (provide a `guard`!), or `false` to skip
   * registration entirely.
   */
  dashboard?: boolean
  /** Custom auth guard for the dashboard. Receives the request context, returns boolean. */
  guard?: (ctx: Context) => boolean | Promise<boolean>
}

const DEV_ENVS = new Set(['local', 'development', 'test'])

export default class DevtoolsProvider extends ServiceProvider {
  readonly name = 'devtools'
  override readonly dependencies = ['database']

  constructor(private options?: DevtoolsProviderOptions) {
    super()
  }

  override register(app: Application): void {
    app.singleton(DevtoolsManager)
  }

  override async boot(app: Application): Promise<void> {
    app.resolve(DevtoolsManager)

    if (this.options?.ensureTables !== false) {
      await DevtoolsManager.ensureTables()
    }

    if (!DevtoolsManager.config.enabled) return

    const router = app.resolve(Router)

    if (this.options?.middleware !== false) {
      router.use(DevtoolsManager.middleware())
    }

    if (this.shouldMountDashboard(app)) {
      registerDashboard(router, this.options?.guard)
    }
  }

  override shutdown(): void {
    DevtoolsManager.teardown()
  }

  private shouldMountDashboard(app: Application): boolean {
    const explicit = this.options?.dashboard
    if (typeof explicit === 'boolean') return explicit
    // Unset → only mount in known dev/test environments. Production-by-default
    // is the safer fail-mode: an app that forgets to opt out won't expose
    // the dashboard captures (request bodies, log context, exceptions) on
    // its public surface even if env-gating elsewhere is misconfigured.
    let env = 'production'
    try {
      const config = app.resolve(Configuration)
      env = String(config.get('app.env', 'production') ?? 'production').toLowerCase()
    } catch {
      // Configuration not registered — keep the production default.
    }
    return DEV_ENVS.has(env)
  }
}
