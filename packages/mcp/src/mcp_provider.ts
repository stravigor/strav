import { ServiceProvider } from '@strav/kernel'
import type { Application } from '@strav/kernel'
import { Router } from '@strav/http'
import type { Middleware } from '@strav/http'
import McpManager from './mcp_manager.ts'
import { mountHttpTransport } from './transports/bun_http_transport.ts'
import type { EventStore } from './transports/bun_http_transport.ts'
import type { TaskStore, TaskMessageQueue } from './tasks.ts'

export interface McpProviderOptions {
  /** Auto-mount HTTP transport on the router. Default: `true` */
  mountHttp?: boolean
  /**
   * Middleware to run on every MCP HTTP request, e.g. `[oauth(), scopes('mcp')]`.
   * Rejections (401 / 403) short-circuit before any handler runs.
   */
  middleware?: Middleware[]
  /** Event store enabling Streamable-HTTP resumability via `Last-Event-ID`. */
  eventStore?: EventStore
  /**
   * Custom task store backing MCP Tasks. Defaults to the SDK's in-memory
   * store; supply a database- or `@strav/durable`-backed store for
   * crash-resumable tasks.
   */
  taskStore?: TaskStore
  /** Custom task message queue, paired with `taskStore`. */
  taskMessageQueue?: TaskMessageQueue
}

export default class McpProvider extends ServiceProvider {
  readonly name = 'mcp'
  override readonly dependencies = ['config']

  constructor(private options?: McpProviderOptions) {
    super()
  }

  override register(app: Application): void {
    app.singleton(McpManager)
  }

  override async boot(app: Application): Promise<void> {
    app.resolve(McpManager)

    // Load user registration file if configured
    const registerPath = McpManager.config.register
    if (registerPath) {
      await import(`${process.cwd()}/${registerPath}`)
    }

    // Apply a custom task store before the server is built
    if (this.options?.taskStore) {
      McpManager.useTaskStore(this.options.taskStore, this.options.taskMessageQueue)
    }

    // Mount HTTP transport on the router
    if (this.options?.mountHttp !== false && McpManager.config.http.enabled) {
      const router = app.resolve(Router)
      mountHttpTransport(router, {
        middleware: this.options?.middleware,
        eventStore: this.options?.eventStore,
      })
    }
  }

  override shutdown(): void {
    McpManager.reset()
  }
}
