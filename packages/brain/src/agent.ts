import type {
  ToolDefinition,
  ToolCall,
  ToolCallRecord,
  AgentResult,
  OutputSchema,
} from './types.ts'

/**
 * Base class for AI agents.
 *
 * Extend this class to define an agent with custom instructions,
 * tools, structured output, and lifecycle hooks.
 *
 * @example
 * class SupportAgent extends Agent {
 *   provider = 'anthropic'
 *   model = 'claude-sonnet-4-5-20250929'
 *   instructions = 'You are a customer support agent.'
 *   tools = [searchTool, lookupOrderTool]
 *
 *   output = z.object({
 *     reply: z.string(),
 *     category: z.enum(['billing', 'shipping', 'product', 'other']),
 *   })
 *
 *   onToolCall(call: ToolCall) {
 *     console.log(`Calling tool: ${call.name}`)
 *   }
 * }
 */
export abstract class Agent {
  /** Provider name (e.g., 'anthropic', 'openai'). Falls back to config default. */
  provider?: string

  /** Model identifier. Falls back to the provider's configured default model. */
  model?: string

  /** System prompt / instructions for this agent. Supports `{{key}}` context interpolation. */
  instructions: string = ''

  /** Tools available to this agent during execution. */
  tools?: ToolDefinition[]

  /** Structured output schema (Zod or JSON Schema). When set, the final response is parsed and validated. */
  output?: OutputSchema

  /** Maximum tool-use loop iterations before forcing a stop. Falls back to config default (10). */
  maxIterations?: number

  /** Maximum tokens per completion request. Falls back to config default (4096). */
  maxTokens?: number

  /** Temperature for completion requests. Falls back to config default (0.7). */
  temperature?: number

  // ── Lifecycle hooks (optional) ───────────────────────────────────────────

  /** Called before the first completion request. */
  onStart?(input: string, context: Record<string, unknown>): void | Promise<void>

  /** Called when the model requests a tool call, before execution. */
  onToolCall?(call: ToolCall): void | Promise<void>

  /**
   * Called before a tool is executed. Return `true` to suspend the agent loop
   * before running this tool call; the runner will return a `SuspendedRun`
   * with a JSON-serializable snapshot of the loop state. Resume later via
   * `AgentRunner.resume(state, toolResults)` once the tool result is known.
   *
   * This is a policy-free primitive: the framework does not attach meaning
   * to suspension. Integrators can use it to gate mutating tools on human
   * approval, dispatch a tool to an external worker, rate-limit, etc.
   *
   * When suspension occurs mid-batch, the triggering call and any remaining
   * unprocessed calls in the same batch are captured together in
   * `pendingToolCalls` so the provider's tool_use/tool_result contract stays
   * balanced on resume.
   */
  shouldSuspend?(
    call: ToolCall,
    context: Record<string, unknown>
  ): boolean | Promise<boolean>

  /** Called after a tool finishes execution. */
  onToolResult?(call: ToolCallRecord): void | Promise<void>

  /** Called when the agent run completes successfully. */
  onComplete?(result: AgentResult): void | Promise<void>

  /** Called when the agent run encounters an error. */
  onError?(error: Error): void | Promise<void>
}
