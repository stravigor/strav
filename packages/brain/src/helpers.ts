import BrainManager from './brain_manager.ts'
import { Agent } from './agent.ts'
import { Workflow } from './workflow.ts'
import { zodToJsonSchema } from './utils/schema.ts'
import { MemoryManager } from './memory/memory_manager.ts'
import { ContextBudget } from './memory/context_budget.ts'
import type { MemoryConfig, SerializedMemoryThread, Fact } from './memory/types.ts'
import type { SemanticMemory } from './memory/semantic_memory.ts'
import type {
  AIProvider,
  CompletionRequest,
  CompletionResponse,
  StreamChunk,
  Message,
  ToolCall,
  ToolCallRecord,
  ToolDefinition,
  AgentResult,
  AgentEvent,
  Usage,
  JsonSchema,
  SerializedThread,
  SerializedAgentState,
  SuspendedRun,
  ToolCallResult,
} from './types.ts'

// ── Shared tool executor ─────────────────────────────────────────────────────

/** Execute a single tool call, returning the result and the tool message. */
async function executeTool(
  tools: ToolDefinition[] | undefined,
  toolCall: ToolCall,
  context?: Record<string, unknown>
): Promise<{ result: unknown; message: Message }> {
  const toolDef = tools?.find(t => t.name === toolCall.name)
  let result: unknown

  if (!toolDef) {
    result = `Error: Tool "${toolCall.name}" not found`
  } else {
    try {
      result = await toolDef.execute(toolCall.arguments, context)
    } catch (err) {
      result = `Error: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  return {
    result,
    message: {
      role: 'tool',
      toolCallId: toolCall.id,
      content: typeof result === 'string' ? result : JSON.stringify(result),
    },
  }
}

// ── Helper Options ───────────────────────────────────────────────────────────

export interface ChatOptions {
  provider?: string
  model?: string
  system?: string
  maxTokens?: number
  temperature?: number
}

export interface GenerateOptions<T = any> {
  prompt: string
  schema: any
  provider?: string
  model?: string
  system?: string
  maxTokens?: number
  temperature?: number
}

export interface GenerateResult<T = any> {
  data: T
  text: string
  usage: Usage
}

export interface EmbedOptions {
  provider?: string
  model?: string
}

// ── brain Helper Object ─────────────────────────────────────────────────────

export const brain = {
  /**
   * One-shot chat completion. Returns the text response.
   *
   * @example
   * const answer = await brain.chat('What is the capital of France?')
   * const answer = await brain.chat('Explain X', { provider: 'openai', model: 'gpt-4o-mini' })
   */
  async chat(prompt: string, options: ChatOptions = {}): Promise<string> {
    const config = BrainManager.config
    const providerName = options.provider ?? config.default

    const response = await BrainManager.complete(providerName, {
      model:
        (options.model ?? BrainManager.provider(providerName).name === 'anthropic')
          ? (BrainManager.config.providers[providerName]?.model ?? config.default)
          : (BrainManager.config.providers[providerName]?.model ?? ''),
      messages: [{ role: 'user', content: prompt }],
      system: options.system,
      maxTokens: options.maxTokens ?? config.maxTokens,
      temperature: options.temperature ?? config.temperature,
    })

    return response.content
  },

  /**
   * One-shot streaming completion.
   *
   * @example
   * for await (const chunk of brain.stream('Write a poem')) {
   *   if (chunk.type === 'text') process.stdout.write(chunk.text!)
   * }
   */
  async *stream(prompt: string, options: ChatOptions = {}): AsyncIterable<StreamChunk> {
    const config = BrainManager.config
    const providerName = options.provider ?? config.default
    const provider = BrainManager.provider(providerName)
    const providerConfig = config.providers[providerName]

    yield* provider.stream({
      model: options.model ?? providerConfig?.model ?? '',
      messages: [{ role: 'user', content: prompt }],
      system: options.system,
      maxTokens: options.maxTokens ?? config.maxTokens,
      temperature: options.temperature ?? config.temperature,
    })
  },

  /**
   * Structured output completion. Returns typed data validated against the schema.
   *
   * @example
   * const { data } = await brain.generate({
   *   prompt: 'Extract: "John is 30"',
   *   schema: z.object({ name: z.string(), age: z.number() }),
   * })
   * // data.name === 'John', data.age === 30
   */
  async generate<T>(options: GenerateOptions<T>): Promise<GenerateResult<T>> {
    const config = BrainManager.config
    const providerName = options.provider ?? config.default
    const providerConfig = config.providers[providerName]
    const jsonSchema = zodToJsonSchema(options.schema)

    const response = await BrainManager.complete(providerName, {
      model: options.model ?? providerConfig?.model ?? '',
      messages: [{ role: 'user', content: options.prompt }],
      system: options.system,
      schema: jsonSchema,
      maxTokens: options.maxTokens ?? config.maxTokens,
      temperature: options.temperature ?? config.temperature,
    })

    // Extract JSON from potential markdown wrapper
    let jsonContent = response.content.trim()
    if (jsonContent.startsWith('```json') || jsonContent.startsWith('```')) {
      // Strip markdown code fence wrapper
      jsonContent = jsonContent.replace(/^```(?:json)?\n?/, '').replace(/\n?```\s*$/, '')
    }

    const parsed = JSON.parse(jsonContent)
    const data = options.schema?.parse ? options.schema.parse(parsed) : parsed

    return {
      data,
      text: response.content,
      usage: response.usage,
    }
  },

  /**
   * Generate embeddings for the given text(s).
   *
   * @example
   * const vectors = await brain.embed('Hello world', { provider: 'openai' })
   */
  async embed(input: string | string[], options: EmbedOptions = {}): Promise<number[][]> {
    const providerName = options.provider ?? BrainManager.config.default
    const provider = BrainManager.provider(providerName)

    if (!provider.embed) {
      throw new Error(`Provider "${providerName}" does not support embeddings.`)
    }

    const result = await provider.embed(input, options.model)
    return result.embeddings
  },

  /** Create a fluent agent runner. */
  agent<T extends Agent>(AgentClass: new () => T): AgentRunner<T> {
    return new AgentRunner(AgentClass)
  },

  /** Create a multi-turn conversation thread. */
  thread(AgentClass?: new () => Agent): Thread {
    return new Thread(AgentClass)
  },

  /** Create a multi-agent workflow. */
  workflow(name: string): Workflow {
    return new Workflow(name)
  },
}

// ── AgentRunner ──────────────────────────────────────────────────────────────

/**
 * Fluent builder for running an agent. Handles the tool-use loop,
 * structured output parsing, and lifecycle hooks.
 *
 * @example
 * const result = await brain.agent(SupportAgent)
 *   .input('Where is my order #12345?')
 *   .with({ orderId: '12345' })
 *   .run()
 */
export class AgentRunner<T extends Agent = Agent> {
  private _input = ''
  private _context: Record<string, unknown> = {}
  private _provider?: string
  private _model?: string
  private _tools?: ToolDefinition[]

  constructor(private AgentClass: new () => T) {}

  /** Set the user input / prompt for the agent. */
  input(text: string): this {
    this._input = text
    return this
  }

  /** Add context variables. Available as `{{key}}` in agent instructions. */
  with(context: Record<string, unknown>): this {
    Object.assign(this._context, context)
    return this
  }

  /** Override the provider (and optionally model) for this run. */
  using(provider: string, model?: string): this {
    this._provider = provider
    if (model) this._model = model
    return this
  }

  /** Set or override the tools available to the agent for this run. */
  tools(tools: ToolDefinition[]): this {
    this._tools = tools
    return this
  }

  /** Run the agent to completion (or until it suspends on a tool call). */
  async run(): Promise<AgentResult | SuspendedRun> {
    return this.runFromState(null)
  }

  /**
   * Resume a previously suspended agent run with the results of the pending
   * tool calls. Returns a completed `AgentResult` — or another `SuspendedRun`
   * if the continuation itself hits another suspending tool call.
   *
   * `toolResults` must contain one entry per call in the original
   * `SuspendedRun.pendingToolCalls`, matched by `toolCallId`. To signal a
   * rejection, pass a string or object describing the error as the
   * `result` — the model sees it as a normal tool failure and adapts.
   */
  async resume(
    state: SerializedAgentState,
    toolResults: ToolCallResult[]
  ): Promise<AgentResult | SuspendedRun> {
    const hydratedMessages: Message[] = [...state.messages]
    const hydratedToolCalls: ToolCallRecord[] = [...state.allToolCalls]

    for (const r of toolResults) {
      const originalCall = findToolCallInMessages(hydratedMessages, r.toolCallId)

      hydratedMessages.push({
        role: 'tool',
        toolCallId: r.toolCallId,
        content: typeof r.result === 'string' ? r.result : JSON.stringify(r.result),
      })

      hydratedToolCalls.push({
        name: originalCall?.name ?? '',
        arguments: originalCall?.arguments ?? {},
        result: r.result,
        duration: 0,
      })
    }

    return this.runFromState({
      messages: hydratedMessages,
      allToolCalls: hydratedToolCalls,
      totalUsage: { ...state.totalUsage },
      iterations: state.iterations,
    })
  }

  /** Shared loop body. Used by both `run()` (fresh state) and `resume()` (restored state). */
  private async runFromState(
    initial: SerializedAgentState | null
  ): Promise<AgentResult | SuspendedRun> {
    const agent = new this.AgentClass()
    const config = BrainManager.config

    // Runner-level tools override agent-level tools
    if (this._tools) {
      agent.tools = this._tools
    }

    const providerName = this._provider ?? agent.provider ?? config.default
    const providerConfig = config.providers[providerName]
    const model = this._model ?? agent.model ?? providerConfig?.model ?? ''
    const maxIterations = agent.maxIterations ?? config.maxIterations
    const maxTokens = agent.maxTokens ?? config.maxTokens
    const temperature = agent.temperature ?? config.temperature

    if (!initial) {
      try {
        await agent.onStart?.(this._input, this._context)
      } catch (err) {
        await agent.onError?.(err instanceof Error ? err : new Error(String(err)))
        throw err
      }
    }

    // Build system prompt with context interpolation
    let system: string | undefined = agent.instructions || undefined
    if (system) {
      for (const [key, value] of Object.entries(this._context)) {
        system = system.replaceAll(`{{${key}}}`, String(value))
      }
    }

    // Prepare structured output schema
    let schema: JsonSchema | undefined
    if (agent.output) {
      schema = zodToJsonSchema(agent.output)
    }

    const messages: Message[] = initial
      ? [...initial.messages]
      : [{ role: 'user', content: this._input }]
    const allToolCalls: ToolCallRecord[] = initial ? [...initial.allToolCalls] : []
    const totalUsage: Usage = initial
      ? { ...initial.totalUsage }
      : { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
    let iterations = initial?.iterations ?? 0

    // Tool loop
    while (iterations < maxIterations) {
      iterations++

      const request: CompletionRequest = {
        model,
        messages: [...messages],
        system,
        maxTokens,
        temperature,
      }

      // Only send tools if the agent has them
      if (agent.tools?.length) {
        request.tools = agent.tools
      }

      // Only send schema when we're not mid-tool-loop (avoid conflicting constraints)
      if (schema && (!agent.tools?.length || iterations > 1)) {
        request.schema = schema
      }

      let response: CompletionResponse
      try {
        response = await BrainManager.complete(providerName, request)
      } catch (err) {
        await agent.onError?.(err instanceof Error ? err : new Error(String(err)))
        throw err
      }

      // Accumulate usage
      totalUsage.inputTokens += response.usage.inputTokens
      totalUsage.outputTokens += response.usage.outputTokens
      totalUsage.totalTokens += response.usage.totalTokens

      // Append assistant message
      messages.push({
        role: 'assistant',
        content: response.content,
        toolCalls: response.toolCalls.length > 0 ? response.toolCalls : undefined,
      })

      // If no tool calls, we're done
      if (response.stopReason !== 'tool_use' || response.toolCalls.length === 0) {
        let data: any = response.content
        if (agent.output && response.content) {
          try {
            // Extract JSON from potential markdown wrapper
            let jsonContent = response.content.trim()
            if (jsonContent.startsWith('```json') || jsonContent.startsWith('```')) {
              // Strip markdown code fence wrapper
              jsonContent = jsonContent.replace(/^```(?:json)?\n?/, '').replace(/\n?```\s*$/, '')
            }

            const parsed = JSON.parse(jsonContent)
            data = agent.output.parse ? agent.output.parse(parsed) : parsed
          } catch {
            data = response.content
          }
        }

        const result: AgentResult = {
          data,
          text: response.content,
          toolCalls: allToolCalls,
          messages,
          usage: totalUsage,
          iterations,
        }

        await agent.onComplete?.(result)
        return result
      }

      // Execute tool calls (or suspend if the agent vetos)
      const suspension = await this.executeTools(
        agent,
        response.toolCalls,
        messages,
        allToolCalls,
        totalUsage,
        iterations
      )
      if (suspension) return suspension
    }

    // Max iterations reached — return what we have
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant')
    const text = typeof lastAssistant?.content === 'string' ? lastAssistant.content : ''

    const result: AgentResult = {
      data: null,
      text,
      toolCalls: allToolCalls,
      messages,
      usage: totalUsage,
      iterations,
    }

    await agent.onComplete?.(result)
    return result
  }

  /** Run the agent with streaming, yielding events for each text chunk and tool execution. */
  async *stream(): AsyncIterable<AgentEvent> {
    const agent = new this.AgentClass()
    const config = BrainManager.config

    // Runner-level tools override agent-level tools
    if (this._tools) {
      agent.tools = this._tools
    }

    const providerName = this._provider ?? agent.provider ?? config.default
    const providerConfig = config.providers[providerName]
    const model = this._model ?? agent.model ?? providerConfig?.model ?? ''
    const maxIterations = agent.maxIterations ?? config.maxIterations
    const maxTokens = agent.maxTokens ?? config.maxTokens
    const temperature = agent.temperature ?? config.temperature
    const provider = BrainManager.provider(providerName)

    await agent.onStart?.(this._input, this._context)

    let system: string | undefined = agent.instructions || undefined
    if (system) {
      for (const [key, value] of Object.entries(this._context)) {
        system = system.replaceAll(`{{${key}}}`, String(value))
      }
    }

    let schema: JsonSchema | undefined
    if (agent.output) {
      schema = zodToJsonSchema(agent.output)
    }

    const messages: Message[] = [{ role: 'user', content: this._input }]
    const allToolCalls: ToolCallRecord[] = []
    const totalUsage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
    let iterations = 0

    while (iterations < maxIterations) {
      iterations++

      if (iterations > 1) {
        yield { type: 'iteration', iteration: iterations }
      }

      const request: CompletionRequest = {
        model,
        messages: [...messages],
        system,
        maxTokens,
        temperature,
      }

      if (agent.tools?.length) request.tools = agent.tools
      if (schema && (!agent.tools?.length || iterations > 1)) request.schema = schema

      // Stream the response
      let fullText = ''
      const pendingToolCalls: Map<number, { id: string; name: string; args: string }> = new Map()

      for await (const chunk of provider.stream(request)) {
        if (chunk.type === 'text' && chunk.text) {
          fullText += chunk.text
          yield { type: 'text', text: chunk.text }
        } else if (chunk.type === 'tool_start' && chunk.toolCall) {
          pendingToolCalls.set(chunk.toolIndex ?? 0, {
            id: chunk.toolCall.id ?? '',
            name: chunk.toolCall.name ?? '',
            args: '',
          })
        } else if (chunk.type === 'tool_delta' && chunk.text) {
          const pending = pendingToolCalls.get(chunk.toolIndex ?? 0)
          if (pending) pending.args += chunk.text
        } else if (chunk.type === 'usage' && chunk.usage) {
          totalUsage.inputTokens += chunk.usage.inputTokens
          totalUsage.outputTokens += chunk.usage.outputTokens
          totalUsage.totalTokens += chunk.usage.totalTokens
        }
      }

      // Build tool calls from accumulated stream data
      const toolCalls: ToolCall[] = []
      for (const [, pending] of pendingToolCalls) {
        let args: Record<string, unknown> = {}
        try {
          args = JSON.parse(pending.args)
        } catch {
          args = pending.args ? { _raw: pending.args } : {}
        }
        toolCalls.push({ id: pending.id, name: pending.name, arguments: args })
      }

      // Append assistant message
      messages.push({
        role: 'assistant',
        content: fullText,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      })

      // If no tool calls, done
      if (toolCalls.length === 0) {
        let data: any = fullText
        if (agent.output && fullText) {
          try {
            const parsed = JSON.parse(fullText)
            data = agent.output.parse ? agent.output.parse(parsed) : parsed
          } catch {
            data = fullText
          }
        }

        const result: AgentResult = {
          data,
          text: fullText,
          toolCalls: allToolCalls,
          messages,
          usage: totalUsage,
          iterations,
        }

        await agent.onComplete?.(result)
        yield { type: 'done', result }
        return
      }

      // Execute tools and yield events (or suspend if the agent vetos)
      for (let i = 0; i < toolCalls.length; i++) {
        const toolCall = toolCalls[i]!

        if (agent.shouldSuspend) {
          const suspend = await agent.shouldSuspend(toolCall, this._context)
          if (suspend) {
            const suspended: SuspendedRun = {
              status: 'suspended',
              pendingToolCalls: toolCalls.slice(i),
              state: {
                messages: [...messages],
                allToolCalls: [...allToolCalls],
                totalUsage: { ...totalUsage },
                iterations,
              },
            }
            yield { type: 'suspended', suspended }
            return
          }
        }

        await agent.onToolCall?.(toolCall)

        const start = performance.now()
        const { result: toolResult, message } = await executeTool(agent.tools, toolCall)
        const duration = performance.now() - start

        const record: ToolCallRecord = {
          name: toolCall.name,
          arguments: toolCall.arguments,
          result: toolResult,
          duration,
        }
        allToolCalls.push(record)
        await agent.onToolResult?.(record)

        yield { type: 'tool_result', toolCall: record }

        messages.push(message)
      }
    }

    // Max iterations
    const lastAssistant = [...messages].reverse().find(m => m.role === 'assistant')
    const text = typeof lastAssistant?.content === 'string' ? lastAssistant.content : ''

    const result: AgentResult = {
      data: null,
      text,
      toolCalls: allToolCalls,
      messages,
      usage: totalUsage,
      iterations,
    }

    await agent.onComplete?.(result)
    yield { type: 'done', result }
  }

  // ── Private ────────────────────────────────────────────────────────────────

  private async executeTools(
    agent: Agent,
    toolCalls: ToolCall[],
    messages: Message[],
    allToolCalls: ToolCallRecord[],
    totalUsage: Usage,
    iterations: number
  ): Promise<SuspendedRun | null> {
    for (let i = 0; i < toolCalls.length; i++) {
      const toolCall = toolCalls[i]!

      if (agent.shouldSuspend) {
        const suspend = await agent.shouldSuspend(toolCall, this._context)
        if (suspend) {
          // Capture this call + all remaining calls in the batch so the
          // provider's tool_use/tool_result contract stays balanced on resume.
          return {
            status: 'suspended',
            pendingToolCalls: toolCalls.slice(i),
            state: {
              messages: [...messages],
              allToolCalls: [...allToolCalls],
              totalUsage: { ...totalUsage },
              iterations,
            },
          }
        }
      }

      await agent.onToolCall?.(toolCall)

      const start = performance.now()
      const { result, message } = await executeTool(agent.tools, toolCall, this._context)
      const duration = performance.now() - start

      const record: ToolCallRecord = {
        name: toolCall.name,
        arguments: toolCall.arguments,
        result,
        duration,
      }
      allToolCalls.push(record)
      await agent.onToolResult?.(record)

      messages.push(message)
    }
    return null
  }
}

// ── Helpers for resume ───────────────────────────────────────────────────────

/**
 * Walk `messages` backwards and find the `ToolCall` (on an assistant message)
 * whose id matches `toolCallId`. Returns undefined if not found.
 */
function findToolCallInMessages(messages: Message[], toolCallId: string): ToolCall | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === 'assistant' && m.toolCalls) {
      const call = m.toolCalls.find(c => c.id === toolCallId)
      if (call) return call
    }
  }
  return undefined
}

// ── Thread ────────────────────────────────────────────────────────────────────

/**
 * Multi-turn conversation thread with optional agent configuration.
 *
 * @example
 * const thread = brain.thread()
 * thread.system('You are a helpful assistant.')
 * const r1 = await thread.send('My name is Alice')
 * const r2 = await thread.send('What is my name?')
 *
 * // With agent
 * const thread = brain.thread(SupportAgent)
 * const r1 = await thread.send('I need help with order #123')
 */
export class Thread {
  private messages: Message[] = []
  private _provider?: string
  private _model?: string
  private _system?: string
  private _tools?: ToolDefinition[]
  private _maxTokens?: number
  private _temperature?: number
  private _memoryManager?: MemoryManager
  private _id?: string
  private _autoPersist = false

  constructor(AgentClass?: new () => Agent) {
    if (AgentClass) {
      const agent = new AgentClass()
      this._provider = agent.provider
      this._model = agent.model
      this._system = agent.instructions || undefined
      this._tools = agent.tools
      this._maxTokens = agent.maxTokens
      this._temperature = agent.temperature
    }
  }

  /** Set or override the system prompt. */
  system(prompt: string): this {
    this._system = prompt
    return this
  }

  /** Override the provider (and optionally model). */
  using(provider: string, model?: string): this {
    this._provider = provider
    if (model) this._model = model
    return this
  }

  /** Set tools available in this thread. */
  tools(tools: ToolDefinition[]): this {
    this._tools = tools
    return this
  }

  /**
   * Enable memory management with optional config overrides.
   *
   * When enabled, the thread automatically:
   * - Tracks token usage against the context window budget
   * - Compacts older messages into summaries when approaching the limit
   * - Extracts and injects semantic facts into the system prompt
   *
   * Memory is opt-in — without calling `.memory()`, Thread behaves
   * exactly as before (sends full messages array every turn).
   */
  memory(config?: Partial<MemoryConfig>): this {
    const memConfig: MemoryConfig = { ...BrainManager.memoryConfig, ...config }
    const providerName = this._provider ?? BrainManager.config.default
    const providerConfig = BrainManager.config.providers[providerName]
    const model = this._model ?? providerConfig?.model ?? ''
    const budget = new ContextBudget(memConfig, model)
    this._memoryManager = new MemoryManager(memConfig, budget)
    return this
  }

  /** Set a thread ID (required for persistence). */
  id(threadId: string): this {
    this._id = threadId
    return this
  }

  /** Enable auto-persistence to the configured ThreadStore after each send(). */
  persist(auto = true): this {
    this._autoPersist = auto
    return this
  }

  /** Access the semantic memory (facts), if memory management is enabled. */
  get facts(): SemanticMemory | undefined {
    return this._memoryManager?.facts
  }

  /** Get the current episodic summary, if memory management is enabled. */
  get episodicSummary(): string | undefined {
    return this._memoryManager?.episodicSummary
  }

  /** Send a message and get the assistant's response. Handles tool calls automatically. */
  async send(message: string): Promise<string> {
    const config = BrainManager.config
    const providerName = this._provider ?? config.default
    const providerConfig = config.providers[providerName]
    const model = this._model ?? providerConfig?.model ?? ''

    this.messages.push({ role: 'user', content: message })

    const maxIterations = 10
    let iterations = 0

    while (iterations < maxIterations) {
      iterations++

      let contextSystem = this._system
      let contextMessages = [...this.messages]

      // Memory management: prepare context within budget
      if (this._memoryManager) {
        const prepared = await this._memoryManager.prepareContext(this._system, this.messages, {
          provider: providerName,
          model,
        })
        contextSystem = prepared.system
        contextMessages = prepared.messages
      }

      const request: CompletionRequest = {
        model,
        messages: contextMessages,
        system: contextSystem,
        maxTokens: this._maxTokens ?? config.maxTokens,
        temperature: this._temperature ?? config.temperature,
      }

      if (this._tools?.length) request.tools = this._tools

      const response = await BrainManager.complete(providerName, request)

      this.messages.push({
        role: 'assistant',
        content: response.content,
        toolCalls: response.toolCalls.length > 0 ? response.toolCalls : undefined,
      })

      // If no tool calls, return
      if (response.stopReason !== 'tool_use' || response.toolCalls.length === 0) {
        await this.autoPersist()
        return response.content
      }

      // Execute tools
      for (const toolCall of response.toolCalls) {
        const { message: toolMessage } = await executeTool(this._tools, toolCall)
        this.messages.push(toolMessage)
      }
    }

    // Return last assistant content
    const last = [...this.messages].reverse().find(m => m.role === 'assistant')
    await this.autoPersist()
    return typeof last?.content === 'string' ? last.content : ''
  }

  /** Stream a message response. Handles tool calls automatically for multi-turn. */
  async *stream(message: string): AsyncIterable<StreamChunk> {
    const config = BrainManager.config
    const providerName = this._provider ?? config.default
    const providerConfig = config.providers[providerName]
    const model = this._model ?? providerConfig?.model ?? ''
    const provider = BrainManager.provider(providerName)

    this.messages.push({ role: 'user', content: message })

    const maxIterations = 10
    let iterations = 0

    while (iterations < maxIterations) {
      iterations++

      let contextSystem = this._system
      let contextMessages = [...this.messages]

      // Memory management: prepare context within budget
      if (this._memoryManager) {
        const prepared = await this._memoryManager.prepareContext(this._system, this.messages, {
          provider: providerName,
          model,
        })
        contextSystem = prepared.system
        contextMessages = prepared.messages
      }

      let fullText = ''
      const pendingToolCalls: Map<number, { id: string; name: string; args: string }> = new Map()

      for await (const chunk of provider.stream({
        model,
        messages: contextMessages,
        system: contextSystem,
        tools: this._tools,
        maxTokens: this._maxTokens ?? config.maxTokens,
        temperature: this._temperature ?? config.temperature,
      })) {
        yield chunk

        if (chunk.type === 'text' && chunk.text) {
          fullText += chunk.text
        } else if (chunk.type === 'tool_start' && chunk.toolCall) {
          pendingToolCalls.set(chunk.toolIndex ?? 0, {
            id: chunk.toolCall.id ?? '',
            name: chunk.toolCall.name ?? '',
            args: '',
          })
        } else if (chunk.type === 'tool_delta' && chunk.text) {
          const pending = pendingToolCalls.get(chunk.toolIndex ?? 0)
          if (pending) pending.args += chunk.text
        }
      }

      // Build tool calls from accumulated stream data
      const toolCalls: ToolCall[] = []
      for (const [, pending] of pendingToolCalls) {
        let args: Record<string, unknown> = {}
        try {
          args = JSON.parse(pending.args)
        } catch {
          args = pending.args ? { _raw: pending.args } : {}
        }
        toolCalls.push({ id: pending.id, name: pending.name, arguments: args })
      }

      // Append assistant message
      this.messages.push({
        role: 'assistant',
        content: fullText,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      })

      // No tool calls — done
      if (toolCalls.length === 0) {
        await this.autoPersist()
        return
      }

      // Execute tools
      for (const toolCall of toolCalls) {
        const { message: toolMessage } = await executeTool(this._tools, toolCall)
        this.messages.push(toolMessage)
      }
    }

    await this.autoPersist()
  }

  /** Get a copy of all messages in this thread. */
  getMessages(): Message[] {
    return [...this.messages]
  }

  /** Serialize the thread for persistence (session, database, cache). */
  serialize(): SerializedThread {
    return {
      messages: [...this.messages],
      system: this._system,
    }
  }

  /** Restore a previously serialized thread. */
  restore(data: SerializedThread): this {
    this.messages = [...data.messages]
    this._system = data.system
    return this
  }

  /**
   * Extended serialization that includes memory state (summary, facts).
   * Use this instead of serialize() when memory management is enabled.
   */
  serializeMemory(): SerializedMemoryThread {
    const memState = this._memoryManager?.serialize()
    return {
      id: this._id ?? crypto.randomUUID(),
      messages: [...this.messages],
      system: this._system,
      summary: memState?.summary,
      facts: memState?.facts,
      updatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    }
  }

  /**
   * Restore from extended serialization that includes memory state.
   * Use this instead of restore() when memory management is enabled.
   */
  restoreMemory(data: SerializedMemoryThread): this {
    this.messages = [...data.messages]
    this._system = data.system
    this._id = data.id

    if (this._memoryManager && (data.summary || data.facts)) {
      this._memoryManager.restore({
        summary: data.summary,
        facts: data.facts,
      })
    }

    return this
  }

  /** Clear all messages and memory state from the thread. */
  clear(): this {
    this.messages = []
    return this
  }

  // ── Private ────────────────────────────────────────────────────────────────

  /** Persist the thread if auto-persist is enabled and a store is configured. */
  private async autoPersist(): Promise<void> {
    if (this._autoPersist && this._id && BrainManager.threadStore) {
      await BrainManager.threadStore.save(this.serializeMemory())
    }
  }
}
