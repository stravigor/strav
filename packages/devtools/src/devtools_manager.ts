import { inject, Configuration, Emitter, ConfigurationError } from '@strav/kernel'
import { Database } from '@strav/database'
import type { DevtoolsConfig, CollectorOptions } from './types.ts'

import EntryStore from './storage/entry_store.ts'
import AggregateStore from './storage/aggregate_store.ts'

import type Collector from './collectors/collector.ts'
import RequestCollector from './collectors/request_collector.ts'
import QueryCollector from './collectors/query_collector.ts'
import ExceptionCollector from './collectors/exception_collector.ts'
import LogCollector from './collectors/log_collector.ts'
import JobCollector from './collectors/job_collector.ts'

import type Recorder from './recorders/recorder.ts'
import SlowRequestsRecorder from './recorders/slow_requests.ts'
import SlowQueriesRecorder from './recorders/slow_queries.ts'

/**
 * Central DI hub for the devtools package.
 *
 * Resolved once via the DI container — reads devtools config, creates
 * storage instances, boots collectors and recorders, and exposes the
 * middleware and dashboard APIs.
 *
 * @example
 * app.singleton(DevtoolsManager)
 * app.resolve(DevtoolsManager)
 *
 * // Use the request-tracking middleware
 * router.use(DevtoolsManager.middleware())
 */
@inject
export default class DevtoolsManager {
  private static _config: DevtoolsConfig
  private static _entryStore: EntryStore
  private static _aggregateStore: AggregateStore
  private static _collectors: Collector[] = []
  private static _recorders: Recorder[] = []
  private static _requestCollector: RequestCollector
  private static _queryCollector: QueryCollector
  private static _currentBatchId: string = crypto.randomUUID()
  private static _booted = false

  constructor(db: Database, config: Configuration) {
    if (DevtoolsManager._booted) return

    DevtoolsManager._config = {
      enabled: config.get('devtools.enabled', true) as boolean,
      routes: {
        aliases: {
          dashboard: config.get('devtools.routes.aliases.dashboard', 'devtools.dashboard') as string,
          api: config.get('devtools.routes.aliases.api', 'devtools.api') as string,
        },
        subdomain: config.get('devtools.routes.subdomain') as string | undefined,
      },
      storage: {
        pruneAfter: config.get('devtools.storage.pruneAfter', 24) as number,
      },
      collectors: {
        request: config.get('devtools.collectors.request', {
          enabled: true,
          sizeLimit: 64,
        }) as CollectorOptions & { sizeLimit: number },
        query: config.get('devtools.collectors.query', {
          enabled: true,
          slow: 100,
        }) as CollectorOptions & { slow: number },
        exception: config.get('devtools.collectors.exception', {
          enabled: true,
        }) as CollectorOptions,
        log: config.get('devtools.collectors.log', {
          enabled: true,
          level: 'debug',
        }) as CollectorOptions & { level: string },
        job: config.get('devtools.collectors.job', { enabled: true }) as CollectorOptions,
      },
      recorders: {
        slowRequests: config.get('devtools.recorders.slowRequests', {
          enabled: true,
          threshold: 1000,
          sampleRate: 1.0,
        }) as any,
        slowQueries: config.get('devtools.recorders.slowQueries', {
          enabled: true,
          threshold: 1000,
          sampleRate: 1.0,
        }) as any,
      },
    }

    if (!DevtoolsManager._config.enabled) return

    // Initialize storage (use the app's DB connection)
    const sql = db.sql
    DevtoolsManager._entryStore = new EntryStore(sql)
    DevtoolsManager._aggregateStore = new AggregateStore(sql)

    // Boot collectors
    const getBatchId = () => DevtoolsManager._currentBatchId

    DevtoolsManager._requestCollector = new RequestCollector(
      DevtoolsManager._entryStore,
      DevtoolsManager._config.collectors.request
    )

    DevtoolsManager._queryCollector = new QueryCollector(
      DevtoolsManager._entryStore,
      DevtoolsManager._config.collectors.query as any,
      getBatchId
    )

    const exceptionCollector = new ExceptionCollector(
      DevtoolsManager._entryStore,
      DevtoolsManager._config.collectors.exception,
      getBatchId
    )

    const logCollector = new LogCollector(
      DevtoolsManager._entryStore,
      DevtoolsManager._config.collectors.log as any,
      getBatchId
    )

    const jobCollector = new JobCollector(
      DevtoolsManager._entryStore,
      DevtoolsManager._config.collectors.job,
      getBatchId
    )

    DevtoolsManager._collectors = [
      DevtoolsManager._requestCollector,
      DevtoolsManager._queryCollector,
      exceptionCollector,
      logCollector,
      jobCollector,
    ]

    // Boot recorders
    const slowRequests = new SlowRequestsRecorder(
      DevtoolsManager._aggregateStore,
      DevtoolsManager._config.recorders.slowRequests
    )

    const slowQueries = new SlowQueriesRecorder(
      DevtoolsManager._aggregateStore,
      DevtoolsManager._config.recorders.slowQueries
    )

    DevtoolsManager._recorders = [slowRequests, slowQueries]

    // Register all listeners
    for (const collector of DevtoolsManager._collectors) {
      collector.register()
    }
    for (const recorder of DevtoolsManager._recorders) {
      recorder.register()
    }

    // Install the SQL query proxy
    const proxied = DevtoolsManager._queryCollector.installProxy(sql)

    // Replace the connection on the Database class
    // We use Object.defineProperty because Database._connection is private
    // but we need to swap it with our proxied version
    ;(db as any).connection = proxied
    ;(db.constructor as any)._connection = proxied

    DevtoolsManager._booted = true
  }

  static get config(): DevtoolsConfig {
    if (!DevtoolsManager._config) {
      throw new ConfigurationError(
        'DevtoolsManager not configured. Resolve it through the container first.'
      )
    }
    return DevtoolsManager._config
  }

  static get entryStore(): EntryStore {
    return DevtoolsManager._entryStore
  }

  static get aggregateStore(): AggregateStore {
    return DevtoolsManager._aggregateStore
  }

  /** Returns the request-tracking middleware. */
  static middleware() {
    return DevtoolsManager._requestCollector.middleware()
  }

  /** Set the current batch ID (called by the request middleware). */
  static setBatchId(id: string): void {
    DevtoolsManager._currentBatchId = id
  }

  /** Get the current batch ID. */
  static get batchId(): string {
    return DevtoolsManager._currentBatchId
  }

  /** Create the storage tables. Called during setup or first boot. */
  static async ensureTables(): Promise<void> {
    await DevtoolsManager._entryStore.ensureTable()
    await DevtoolsManager._aggregateStore.ensureTable()
  }

  /** Emit internal events for recorders. Called by the request collector. */
  static emitRequest(data: {
    path: string
    method: string
    duration: number
    status: number
  }): void {
    if (Emitter.listenerCount('devtools:request') > 0) {
      Emitter.emit('devtools:request', data).catch(() => {})
    }
  }

  /** Emit internal events for recorders. Called by the query collector. */
  static emitQuery(data: { sql: string; duration: number }): void {
    if (Emitter.listenerCount('devtools:query') > 0) {
      Emitter.emit('devtools:query', data).catch(() => {})
    }
  }

  /** Tear down all collectors and recorders. */
  static teardown(): void {
    for (const collector of DevtoolsManager._collectors) {
      collector.teardown()
    }
    for (const recorder of DevtoolsManager._recorders) {
      recorder.teardown()
    }
    DevtoolsManager._collectors = []
    DevtoolsManager._recorders = []
    DevtoolsManager._booted = false
  }

  /** Reset all static state. For testing only. */
  static reset(): void {
    DevtoolsManager.teardown()
    DevtoolsManager._config = undefined as any
    DevtoolsManager._entryStore = undefined as any
    DevtoolsManager._aggregateStore = undefined as any
  }
}
