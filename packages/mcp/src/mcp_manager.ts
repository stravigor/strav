import { inject, app, Configuration, Emitter, ConfigurationError } from '@strav/kernel'
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js'
import { InMemoryTaskStore, InMemoryTaskMessageQueue } from '@modelcontextprotocol/sdk/experimental'
import type { TaskStore, TaskMessageQueue } from '@modelcontextprotocol/sdk/experimental'
import type { ServerOptions } from '@modelcontextprotocol/sdk/server/index.js'
import type {
  McpConfig,
  ZodRawShape,
  ToolRegistration,
  ToolHandler,
  ToolHandlerContext,
  McpCallerToken,
  McpCallerClient,
  ResourceRegistration,
  ResourceHandler,
  PromptRegistration,
  PromptHandler,
} from './types.ts'
import type { TaskRegistration, TaskOptions } from './tasks.ts'
import { DuplicateRegistrationError } from './errors.ts'

@inject
export default class McpManager {
  private static _config: McpConfig
  private static _server: McpServer | null = null
  private static _tools = new Map<string, ToolRegistration>()
  private static _resources = new Map<string, ResourceRegistration>()
  private static _prompts = new Map<string, PromptRegistration>()
  private static _tasks = new Map<string, TaskRegistration>()
  private static _taskStore: TaskStore | null = null
  private static _taskMessageQueue: TaskMessageQueue | null = null

  constructor(config: Configuration) {
    McpManager._config = {
      name: (config.get('mcp.name') ?? config.get('app.name', 'Strav MCP Server')) as string,
      version: config.get('mcp.version', '1.0.0') as string,
      register: config.get('mcp.register') as string | undefined,
      http: {
        enabled: config.get('mcp.http.enabled', true) as boolean,
        path: config.get('mcp.http.path', '/mcp') as string,
      },
    }
  }

  // ── Configuration ──────────────────────────────────────────────────

  static get config(): McpConfig {
    if (!McpManager._config) {
      throw new ConfigurationError(
        'McpManager not configured. Resolve it through the container first.'
      )
    }
    return McpManager._config
  }

  // ── Builder API ────────────────────────────────────────────────────

  /** Register a tool that AI clients can invoke. */
  static tool<TShape extends ZodRawShape>(
    name: string,
    options: {
      description?: string
      input?: TShape
      handler: ToolHandler<TShape>
    }
  ): void {
    if (McpManager._tools.has(name) || McpManager._tasks.has(name)) {
      throw new DuplicateRegistrationError('tool', name)
    }

    McpManager._tools.set(name, {
      name,
      description: options.description,
      input: options.input,
      handler: options.handler as ToolHandler,
    })

    Emitter.emit('mcp:tool-registered', { name })
  }

  /** Register a resource that AI clients can read. */
  static resource(
    uri: string,
    options: {
      name?: string
      description?: string
      mimeType?: string
      handler: ResourceHandler
    }
  ): void {
    if (McpManager._resources.has(uri)) {
      throw new DuplicateRegistrationError('resource', uri)
    }

    McpManager._resources.set(uri, {
      uri,
      name: options.name,
      description: options.description,
      mimeType: options.mimeType,
      handler: options.handler,
    })

    Emitter.emit('mcp:resource-registered', { uri })
  }

  /** Register a prompt template that AI clients can use. */
  static prompt<TShape extends ZodRawShape>(
    name: string,
    options: {
      description?: string
      args?: TShape
      handler: PromptHandler<TShape>
    }
  ): void {
    if (McpManager._prompts.has(name)) {
      throw new DuplicateRegistrationError('prompt', name)
    }

    McpManager._prompts.set(name, {
      name,
      description: options.description,
      args: options.args,
      handler: options.handler as PromptHandler,
    })

    Emitter.emit('mcp:prompt-registered', { name })
  }

  /**
   * Register a long-running **task** — a tool the client fires and then polls
   * to completion, instead of holding a synchronous call open for minutes.
   */
  static task<TShape extends ZodRawShape>(name: string, options: TaskOptions<TShape>): void {
    if (McpManager._tasks.has(name) || McpManager._tools.has(name)) {
      throw new DuplicateRegistrationError('task', name)
    }

    McpManager._tasks.set(name, {
      name,
      description: options.description,
      input: options.input,
      handler: options.handler as ToolHandler,
      ttl: options.ttl ?? null,
      pollInterval: options.pollInterval,
      taskSupport: options.taskSupport ?? 'required',
    })

    Emitter.emit('mcp:task-registered', { name })
  }

  /**
   * Supply a custom task store (and optional message queue) backing MCP Tasks.
   *
   * Defaults to the SDK's in-memory implementations. Provide a database- or
   * `@strav/durable`-backed `TaskStore` for crash-resumable tasks. Must be
   * called before {@link getServer}.
   */
  static useTaskStore(store: TaskStore, queue?: TaskMessageQueue): void {
    McpManager._taskStore = store
    if (queue) McpManager._taskMessageQueue = queue
  }

  // ── Server ─────────────────────────────────────────────────────────

  /**
   * Build the per-call handler context.
   *
   * Caller identity (when present) arrives via the SDK's `extra.authInfo`,
   * populated by the HTTP transport's middleware. This MUST run per call —
   * the same server instance serves every session, so a once-built context
   * could not carry per-request identity.
   */
  private static buildContext(extra?: any): ToolHandlerContext {
    const ctx: ToolHandlerContext = { app }

    const carried = extra?.authInfo?.extra as Record<string, unknown> | undefined
    if (carried) {
      ctx.oauth_token = carried.oauth_token as McpCallerToken | undefined
      ctx.oauth_client = carried.oauth_client as McpCallerClient | undefined
      ctx.user = carried.user
    }

    if (extra) {
      ctx.request = {
        sessionId: extra.sessionId,
        requestId: extra.requestId,
        signal: extra.signal,
      }
    }

    // Elicitation — request human input mid-call over the server→client
    // channel. Fails at call time if the client lacks the capability.
    const server = McpManager._server
    if (server) {
      ctx.elicit = params =>
        server.server.elicitInput(params, extra?.signal ? { signal: extra.signal } : undefined)
    }

    return ctx
  }

  /**
   * Get or create the MCP server instance.
   *
   * Lazily creates the server and wires all registered tools, resources,
   * and prompts. Each handler builds its context per call from the SDK's
   * `extra` argument, so OAuth-scoped calls reach handlers with caller
   * identity (see {@link buildContext}).
   */
  static getServer(): McpServer {
    if (McpManager._server) return McpManager._server

    // Configure task storage when any task is registered (or a store was
    // explicitly supplied) — the SDK needs it to serve the Tasks protocol,
    // and the `tasks` capability must be advertised so clients task-augment.
    let serverOptions: ServerOptions | undefined
    if (McpManager._tasks.size > 0 || McpManager._taskStore) {
      McpManager._taskStore ??= new InMemoryTaskStore()
      McpManager._taskMessageQueue ??= new InMemoryTaskMessageQueue()
      serverOptions = {
        taskStore: McpManager._taskStore,
        taskMessageQueue: McpManager._taskMessageQueue,
        capabilities: {
          tasks: {
            list: {},
            cancel: {},
            requests: { tools: { call: {} } },
          },
        },
      }
    }

    const server = new McpServer(
      { name: McpManager.config.name, version: McpManager.config.version },
      serverOptions
    )

    // Wire tools — cast at SDK boundary since our handler signature
    // adds the DI context param that the SDK doesn't know about.
    // `extra` is always the LAST callback argument: `(args, extra)` for a
    // tool with an input schema, `(extra)` for one without.
    for (const [name, reg] of McpManager._tools) {
      if (reg.input) {
        const toolCb = async (params: any, extra: any) => {
          const result = await reg.handler(params ?? {}, McpManager.buildContext(extra))
          await Emitter.emit('mcp:tool-called', { name, params })
          return result
        }
        server.registerTool(
          name,
          { description: reg.description, inputSchema: reg.input },
          toolCb as any
        )
      } else {
        const toolCb = async (extra: any) => {
          const result = await reg.handler({} as any, McpManager.buildContext(extra))
          await Emitter.emit('mcp:tool-called', { name, params: {} })
          return result
        }
        server.registerTool(name, { description: reg.description }, toolCb as any)
      }
    }

    // Wire resources — `(uri, extra)` for static, `(uri, variables, extra)`
    // for templated resources.
    for (const [, reg] of McpManager._resources) {
      const isTemplate = reg.uri.includes('{')
      const metadata = {
        title: reg.name,
        description: reg.description,
        mimeType: reg.mimeType,
      }

      if (isTemplate) {
        server.registerResource(
          reg.name ?? reg.uri,
          new ResourceTemplate(reg.uri, { list: undefined }),
          metadata,
          (async (uri: URL, params: Record<string, string>, extra: any) => {
            const result = await reg.handler(uri, params, McpManager.buildContext(extra))
            await Emitter.emit('mcp:resource-read', { uri: uri.href })
            return result
          }) as any
        )
      } else {
        server.registerResource(
          reg.name ?? reg.uri,
          reg.uri,
          metadata,
          (async (uri: URL, extra: any) => {
            const result = await reg.handler(uri, {}, McpManager.buildContext(extra))
            await Emitter.emit('mcp:resource-read', { uri: uri.href })
            return result
          }) as any
        )
      }
    }

    // Wire prompts — `(args, extra)` with an args schema, `(extra)` without.
    for (const [name, reg] of McpManager._prompts) {
      if (reg.args) {
        const promptCb = async (args: any, extra: any) => {
          const result = await reg.handler(args ?? {}, McpManager.buildContext(extra))
          await Emitter.emit('mcp:prompt-called', { name, args })
          return result
        }
        server.registerPrompt(
          name,
          { description: reg.description, argsSchema: reg.args },
          promptCb as any
        )
      } else {
        const promptCb = async (extra: any) => {
          const result = await reg.handler({} as any, McpManager.buildContext(extra))
          await Emitter.emit('mcp:prompt-called', { name, args: {} })
          return result
        }
        server.registerPrompt(name, { description: reg.description }, promptCb as any)
      }
    }

    // Wire tasks — long-running tools the client fires and polls.
    for (const [name, reg] of McpManager._tasks) {
      const taskHandler = McpManager.buildTaskHandler(reg)
      const execution = { taskSupport: reg.taskSupport }
      if (reg.input) {
        server.experimental.tasks.registerToolTask(
          name,
          { description: reg.description, inputSchema: reg.input, execution },
          taskHandler
        )
      } else {
        server.experimental.tasks.registerToolTask(
          name,
          { description: reg.description, execution },
          taskHandler
        )
      }
    }

    McpManager._server = server
    return server
  }

  /**
   * Wrap a {@link TaskRegistration} into the SDK's three-method
   * `ToolTaskHandler`. `createTask` kicks the work off in the background and
   * returns the task handle immediately; `getTask` / `getTaskResult` delegate
   * to the request-scoped task store the client polls.
   */
  private static buildTaskHandler(reg: TaskRegistration): any {
    const hasInput = !!reg.input
    const argsOf = (callArgs: any[]) => (hasInput ? (callArgs[0] ?? {}) : {})
    const extraOf = (callArgs: any[]) => callArgs[callArgs.length - 1]

    return {
      createTask: async (...callArgs: any[]) => {
        const extra = extraOf(callArgs)
        const task = await extra.taskStore.createTask({
          ttl: reg.ttl,
          pollInterval: reg.pollInterval,
        })
        void McpManager.runTask(
          reg,
          task.taskId,
          argsOf(callArgs),
          McpManager.buildContext(extra)
        )
        return { task }
      },
      getTask: async (...callArgs: any[]) => {
        const extra = extraOf(callArgs)
        return extra.taskStore.getTask(extra.taskId)
      },
      getTaskResult: async (...callArgs: any[]) => {
        const extra = extraOf(callArgs)
        return extra.taskStore.getTaskResult(extra.taskId)
      },
    }
  }

  /** Run a task's handler in the background and persist its result. */
  private static async runTask(
    reg: TaskRegistration,
    taskId: string,
    args: any,
    ctx: ToolHandlerContext
  ): Promise<void> {
    const store = McpManager._taskStore
    if (!store) return

    try {
      const result = await reg.handler(args, ctx)
      await store.storeTaskResult(taskId, 'completed', result)
      await Emitter.emit('mcp:task-completed', { name: reg.name, taskId })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // The error detail rides in the stored result (reachable via tasks/result);
      // storeTaskResult also moves the task to the terminal `failed` state.
      await store.storeTaskResult(taskId, 'failed', {
        content: [{ type: 'text', text: message }],
        isError: true,
      })
      await Emitter.emit('mcp:task-failed', { name: reg.name, taskId, error: message })
    }
  }

  // ── Inspection ─────────────────────────────────────────────────────

  static registeredTools(): string[] {
    return Array.from(McpManager._tools.keys())
  }

  static registeredResources(): string[] {
    return Array.from(McpManager._resources.keys())
  }

  static registeredPrompts(): string[] {
    return Array.from(McpManager._prompts.keys())
  }

  static registeredTasks(): string[] {
    return Array.from(McpManager._tasks.keys())
  }

  static getToolRegistration(name: string): ToolRegistration | undefined {
    return McpManager._tools.get(name)
  }

  static getResourceRegistration(uri: string): ResourceRegistration | undefined {
    return McpManager._resources.get(uri)
  }

  static getPromptRegistration(name: string): PromptRegistration | undefined {
    return McpManager._prompts.get(name)
  }

  static getTaskRegistration(name: string): TaskRegistration | undefined {
    return McpManager._tasks.get(name)
  }

  // ── Reset ──────────────────────────────────────────────────────────

  /** Reset all state. Intended for test teardown. */
  static reset(): void {
    McpManager._tools.clear()
    McpManager._resources.clear()
    McpManager._prompts.clear()
    McpManager._tasks.clear()
    McpManager._server = null
    McpManager._taskStore = null
    McpManager._taskMessageQueue = null
    McpManager._config = undefined as any
  }
}
