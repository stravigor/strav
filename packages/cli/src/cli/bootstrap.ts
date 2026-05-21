import Configuration from '@strav/kernel/config/configuration'
import Database from '@strav/database/database/database'
import SchemaRegistry from '@strav/database/schema/registry'
import DatabaseIntrospector from '@strav/database/database/introspector'
import Application from '@strav/kernel/core/application'
import type ServiceProvider from '@strav/kernel/core/service_provider'
import { getDatabasePaths } from '../config/loader.ts'

export interface BootstrapResult {
  config: Configuration
  db: Database
  registry: SchemaRegistry
  introspector: DatabaseIntrospector
}

/**
 * Bootstrap the core framework services needed by CLI commands.
 *
 * Loads configuration, connects to the database, discovers and validates
 * schemas, and creates an introspector instance.
 */
export async function bootstrap(): Promise<BootstrapResult> {
  const config = new Configuration('./config')
  await config.load()

  const db = new Database(config)
  await db.init()

  const registry = new SchemaRegistry()
  const dbPaths = await getDatabasePaths()
  await registry.discover(dbPaths.schemas)
  registry.validate()

  const introspector = new DatabaseIntrospector(db)

  return { config, db, registry, introspector }
}

/** Cleanly close the database connection. */
export async function shutdown(db: Database): Promise<void> {
  await db.close()
}

export interface WithProvidersOptions {
  /**
   * Install SIGINT/SIGTERM handlers for graceful shutdown. Default: `true`.
   * Set to `false` when the caller owns signal handling and must control
   * shutdown ordering — e.g. `queue:work`, which lets the worker drain its
   * in-flight job before `app.shutdown()` tears down providers.
   */
  signalHandlers?: boolean
}

/**
 * Bootstrap an Application with the given service providers.
 *
 * Creates a fresh Application, registers all providers, boots them
 * in dependency order, and returns the running application.
 * Signal handlers for graceful shutdown are installed automatically
 * unless `options.signalHandlers` is `false`.
 *
 * @example
 * const app = await withProviders([
 *   new ConfigProvider(),
 *   new DatabaseProvider(),
 *   new AuthProvider({ resolver: (id) => User.find(id) }),
 * ])
 */
export async function withProviders(
  providers: ServiceProvider[],
  options?: WithProvidersOptions,
): Promise<Application> {
  const app = new Application()
  for (const provider of providers) app.use(provider)
  await app.start(options)
  return app
}
