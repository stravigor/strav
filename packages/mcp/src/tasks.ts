import type { ZodRawShape, ToolHandler } from './types.ts'

/**
 * MCP **Tasks** — long-running tools the client fires and polls to completion,
 * instead of holding a synchronous call open for minutes.
 *
 * The SDK's experimental Tasks primitives are re-exported here so consumers
 * never import from `@modelcontextprotocol/sdk` directly. The `TaskStore` is
 * the pluggable backing seam: ship `InMemoryTaskStore` for a single node, or
 * supply a database / `@strav/durable`-backed store for crash-resumable tasks.
 */

export {
  InMemoryTaskStore,
  InMemoryTaskMessageQueue,
  isTerminal,
} from '@modelcontextprotocol/sdk/experimental'

export type {
  TaskStore,
  TaskMessageQueue,
  CreateTaskOptions,
  Task,
} from '@modelcontextprotocol/sdk/experimental'

/** How a task-capable tool exposes itself: clients must (`required`) or may (`optional`) use the task flow. */
export type TaskSupport = 'required' | 'optional'

/** Options accepted by `mcp.task(name, options)`. */
export interface TaskOptions<TShape extends ZodRawShape = ZodRawShape> {
  /** Human-readable description shown to clients. */
  description?: string
  /** Zod input shape — validated before the handler runs. */
  input?: TShape
  /**
   * The long-running work. Runs in the background after the task is created;
   * its `CallToolResult` becomes the result the client polls for.
   */
  handler: ToolHandler<TShape>
  /** Result retention after completion, in ms. `null` (default) = unlimited. */
  ttl?: number | null
  /** Suggested client poll interval, in ms. */
  pollInterval?: number
  /** Whether clients must (`required`, default) or may (`optional`) use the task flow. */
  taskSupport?: TaskSupport
}

/** A registered MCP Task. */
export interface TaskRegistration<TShape extends ZodRawShape = ZodRawShape> {
  name: string
  description?: string
  input?: TShape
  handler: ToolHandler<TShape>
  ttl: number | null
  pollInterval?: number
  taskSupport: TaskSupport
}
