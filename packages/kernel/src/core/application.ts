import Container from './container.ts'
import type ServiceProvider from './service_provider.ts'
import Emitter from '../events/emitter.ts'

const SHUTDOWN_TIMEOUT = 30_000

/**
 * Application container with service-provider lifecycle management.
 *
 * Extends {@link Container} so all existing DI methods (`singleton`, `resolve`,
 * `register`, `make`, `has`) continue to work unchanged. Adds provider
 * orchestration: topological dependency sort, ordered boot, and reverse-order
 * graceful shutdown on SIGINT / SIGTERM.
 *
 * @example
 * import { app } from '@strav/kernel/core'
 * import { ConfigProvider, DatabaseProvider, AuthProvider } from '@strav/kernel/providers'
 *
 * app
 *   .useProviders([
 *     new ConfigProvider(),
 *     new DatabaseProvider(),
 *     new AuthProvider({ resolver: (id) => User.find(id) })
 *   ])
 *   .onBooted(async () => {
 *     console.log('Application is ready!')
 *   })
 *
 * await app.start()
 */
export default class Application extends Container {
  private _providers: ServiceProvider[] = []
  private _bootedProviders: ServiceProvider[] = []
  private _booted = false
  private _shuttingDown = false
  private _signalHandlers: (() => void)[] = []

  /** Add a service provider. Must be called before {@link start}. */
  use(provider: ServiceProvider): this {
    if (this._booted) {
      throw new Error(`Cannot add provider "${provider.name}" after the application has started.`)
    }
    this._providers.push(provider)
    return this
  }

  /** Add multiple service providers at once. Must be called before {@link start}. */
  useProviders(providers: ServiceProvider[]): this {
    if (this._booted) {
      throw new Error('Cannot add providers after the application has started.')
    }
    this._providers.push(...providers)
    return this
  }

  /** Register a callback to run after the application has booted. */
  onBooted(callback: () => void | Promise<void>): this {
    Emitter.once('app:booted', callback)
    return this
  }

  /**
   * Boot the application.
   *
   * 1. Emit `app:starting`
   * 2. Topologically sort providers by their declared dependencies
   * 3. Call `register()` on every provider (synchronous, binds factories)
   * 4. Call `boot()` on every provider in dependency order (async init)
   * 5. Install SIGINT / SIGTERM handlers for graceful shutdown
   * 6. Emit `app:booted`
   *
   * Pass `{ signalHandlers: false }` to skip step 5 — for callers that
   * install their own signal handling and must control shutdown ordering
   * (e.g. a queue worker that drains its in-flight job before `shutdown()`).
   */
  async start(options?: { signalHandlers?: boolean }): Promise<void> {
    if (this._booted) return

    await Emitter.emit('app:starting')

    // Sort providers so dependencies are booted first
    const sorted = this.topologicalSort(this._providers)

    // Phase 1: register all (synchronous)
    for (const provider of sorted) {
      provider.register(this)
    }

    // Phase 2: boot in order (async)
    for (const provider of sorted) {
      try {
        await provider.boot(this)
        this._bootedProviders.push(provider)
      } catch (error) {
        // Rollback: shutdown already-booted providers in reverse
        await this.shutdownProviders()
        throw error
      }
    }

    this._booted = true
    if (options?.signalHandlers !== false) {
      this.installSignalHandlers()
    }

    await Emitter.emit('app:booted')
  }

  /**
   * Gracefully shut down the application.
   *
   * Calls `shutdown()` on every booted provider in reverse boot order,
   * then exits the process. A 30-second timeout forces exit if providers
   * don't finish in time.
   */
  async shutdown(): Promise<void> {
    if (this._shuttingDown) return
    this._shuttingDown = true

    await Emitter.emit('app:shutdown')

    const timer = setTimeout(() => {
      console.error('Shutdown timed out, forcing exit.')
      process.exit(1)
    }, SHUTDOWN_TIMEOUT)

    try {
      await this.shutdownProviders()
    } finally {
      clearTimeout(timer)
      this.removeSignalHandlers()
      this._booted = false
      this._shuttingDown = false
    }

    await Emitter.emit('app:terminated')
  }

  /** Whether the application has finished booting. */
  get isBooted(): boolean {
    return this._booted
  }

  /** Whether the application is currently shutting down. */
  get isShuttingDown(): boolean {
    return this._shuttingDown
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /** Shutdown booted providers in reverse order. */
  private async shutdownProviders(): Promise<void> {
    const reversed = [...this._bootedProviders].reverse()
    for (const provider of reversed) {
      try {
        await provider.shutdown(this)
      } catch (error) {
        console.error(`Error shutting down provider "${provider.name}":`, error)
      }
    }
    this._bootedProviders = []
  }

  /** Install SIGINT/SIGTERM handlers for graceful shutdown. */
  private installSignalHandlers(): void {
    const handler = () => {
      this.shutdown().then(() => process.exit(0))
    }
    this._signalHandlers.push(handler)
    process.on('SIGINT', handler)
    process.on('SIGTERM', handler)
  }

  /** Remove signal handlers. */
  private removeSignalHandlers(): void {
    for (const handler of this._signalHandlers) {
      process.off('SIGINT', handler)
      process.off('SIGTERM', handler)
    }
    this._signalHandlers = []
  }

  /**
   * Topologically sort providers using Kahn's algorithm.
   *
   * Throws if a provider declares a dependency on an unknown provider name,
   * or if a circular dependency is detected.
   */
  private topologicalSort(providers: ServiceProvider[]): ServiceProvider[] {
    const byName = new Map<string, ServiceProvider>()
    for (const p of providers) {
      if (byName.has(p.name)) {
        throw new Error(`Duplicate provider name: "${p.name}"`)
      }
      byName.set(p.name, p)
    }

    // Build adjacency list and in-degree map
    const inDegree = new Map<string, number>()
    const dependents = new Map<string, string[]>() // dep → providers that depend on it

    for (const p of providers) {
      inDegree.set(p.name, 0)
      dependents.set(p.name, [])
    }

    for (const p of providers) {
      for (const dep of p.dependencies) {
        if (!byName.has(dep)) {
          throw new Error(`Provider "${p.name}" depends on "${dep}", which is not registered.`)
        }
        inDegree.set(p.name, (inDegree.get(p.name) ?? 0) + 1)
        dependents.get(dep)!.push(p.name)
      }
    }

    // Kahn's algorithm
    const queue: string[] = []
    for (const [name, degree] of inDegree) {
      if (degree === 0) queue.push(name)
    }

    const sorted: ServiceProvider[] = []
    while (queue.length > 0) {
      const name = queue.shift()!
      sorted.push(byName.get(name)!)

      for (const dependent of dependents.get(name)!) {
        const newDegree = inDegree.get(dependent)! - 1
        inDegree.set(dependent, newDegree)
        if (newDegree === 0) queue.push(dependent)
      }
    }

    if (sorted.length !== providers.length) {
      const remaining = providers.filter(p => !sorted.includes(p)).map(p => p.name)
      throw new Error(`Circular dependency detected among providers: ${remaining.join(', ')}`)
    }

    return sorted
  }
}

/** Global application container singleton. */
export const app = new Application()
