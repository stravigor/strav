import McpManager from './mcp_manager.ts'
import type {
  ZodRawShape,
  ToolHandler,
  ToolRegistration,
  ResourceHandler,
  ResourceRegistration,
  PromptHandler,
  PromptRegistration,
} from './types.ts'
import type { TaskOptions, TaskRegistration } from './tasks.ts'

/**
 * MCP helper — the primary convenience API.
 *
 * @example
 * import { mcp } from '@strav/mcp'
 * import { z } from 'zod'
 *
 * mcp.tool('get-user', {
 *   description: 'Fetch a user by ID',
 *   input: { id: z.number() },
 *   handler: async ({ id }, { app }) => {
 *     const db = app.resolve(Database)
 *     const [user] = await db.sql`SELECT * FROM users WHERE id = ${id}`
 *     return { content: [{ type: 'text', text: JSON.stringify(user) }] }
 *   }
 * })
 */
export const mcp = {
  /** Register a tool that AI clients can invoke. */
  tool<TShape extends ZodRawShape>(
    name: string,
    options: {
      description?: string
      input?: TShape
      handler: ToolHandler<TShape>
    }
  ): void {
    McpManager.tool(name, options)
  },

  /** Register a resource that AI clients can read. */
  resource(
    uri: string,
    options: {
      name?: string
      description?: string
      mimeType?: string
      handler: ResourceHandler
    }
  ): void {
    McpManager.resource(uri, options)
  },

  /** Register a prompt template that AI clients can use. */
  prompt<TShape extends ZodRawShape>(
    name: string,
    options: {
      description?: string
      args?: TShape
      handler: PromptHandler<TShape>
    }
  ): void {
    McpManager.prompt(name, options)
  },

  /**
   * Register a long-running **task** — a tool the client fires and polls to
   * completion. The handler runs in the background; its result is stored for
   * the client to retrieve.
   *
   * @example
   * mcp.task('deploy', {
   *   description: 'Deploy a milestone',
   *   input: { milestoneId: z.string() },
   *   pollInterval: 2000,
   *   handler: async ({ milestoneId }) => {
   *     await runDeploy(milestoneId)              // minutes of work
   *     return { content: [{ type: 'text', text: 'deployed' }] }
   *   },
   * })
   */
  task<TShape extends ZodRawShape>(name: string, options: TaskOptions<TShape>): void {
    McpManager.task(name, options)
  },

  /** List all registered tool names. */
  registeredTools(): string[] {
    return McpManager.registeredTools()
  },

  /** List all registered resource URIs. */
  registeredResources(): string[] {
    return McpManager.registeredResources()
  },

  /** List all registered prompt names. */
  registeredPrompts(): string[] {
    return McpManager.registeredPrompts()
  },

  /** List all registered task names. */
  registeredTasks(): string[] {
    return McpManager.registeredTasks()
  },

  /** Get a tool registration by name. */
  getToolRegistration(name: string): ToolRegistration | undefined {
    return McpManager.getToolRegistration(name)
  },

  /** Get a resource registration by URI. */
  getResourceRegistration(uri: string): ResourceRegistration | undefined {
    return McpManager.getResourceRegistration(uri)
  },

  /** Get a prompt registration by name. */
  getPromptRegistration(name: string): PromptRegistration | undefined {
    return McpManager.getPromptRegistration(name)
  },

  /** Get a task registration by name. */
  getTaskRegistration(name: string): TaskRegistration | undefined {
    return McpManager.getTaskRegistration(name)
  },
}
