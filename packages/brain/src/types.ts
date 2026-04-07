// ── JSON Schema ──────────────────────────────────────────────────────────────

/** Minimal recursive JSON Schema type. */
export type JsonSchema = Record<string, unknown>

// ── SSE ──────────────────────────────────────────────────────────────────────

export interface SSEEvent {
  event?: string
  data: string
}

// ── Usage ────────────────────────────────────────────────────────────────────

export interface Usage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
}

// ── Messages ─────────────────────────────────────────────────────────────────

export interface ToolCall {
  id: string
  name: string
  arguments: Record<string, unknown>
}

export interface ContentBlock {
  type: 'text' | 'tool_use' | 'tool_result'
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  toolUseId?: string
  content?: string
}

export interface Message {
  role: 'user' | 'assistant' | 'tool'
  content: string | ContentBlock[]
  toolCalls?: ToolCall[]
  toolCallId?: string
}

// ── Tool Definition ──────────────────────────────────────────────────────────

export interface ToolDefinition {
  name: string
  description: string
  parameters: JsonSchema
  execute: (args: Record<string, unknown>, context?: Record<string, unknown>) => unknown | Promise<unknown>
}

// ── Completion Request / Response ────────────────────────────────────────────

export interface CompletionRequest {
  model: string
  messages: Message[]
  system?: string
  tools?: ToolDefinition[]
  toolChoice?: 'auto' | 'required' | { name: string }
  maxTokens?: number
  temperature?: number
  schema?: JsonSchema
  stopSequences?: string[]
}

export interface CompletionResponse {
  id: string
  content: string
  toolCalls: ToolCall[]
  stopReason: 'end' | 'tool_use' | 'max_tokens' | 'stop_sequence'
  usage: Usage
  raw: unknown
}

// ── Streaming ────────────────────────────────────────────────────────────────

export interface StreamChunk {
  type: 'text' | 'tool_start' | 'tool_delta' | 'tool_end' | 'usage' | 'done'
  text?: string
  toolCall?: Partial<ToolCall>
  toolIndex?: number
  usage?: Usage
}

// ── Output Schema ────────────────────────────────────────────────────────────

/** A schema that optionally validates data via `.parse()` (e.g., Zod schema). */
export interface OutputSchema {
  parse?: (data: unknown) => unknown
  [key: string]: unknown
}

// ── Agent ────────────────────────────────────────────────────────────────────

export interface ToolCallRecord {
  name: string
  arguments: Record<string, unknown>
  result: unknown
  duration: number
}

export interface AgentResult<T = any> {
  data: T
  text: string
  toolCalls: ToolCallRecord[]
  messages: Message[]
  usage: Usage
  iterations: number
}

export interface AgentEvent {
  type: 'text' | 'tool_start' | 'tool_result' | 'iteration' | 'done'
  text?: string
  toolCall?: ToolCallRecord
  iteration?: number
  result?: AgentResult
}

// ── Workflow ──────────────────────────────────────────────────────────────────

export interface WorkflowResult {
  results: Record<string, AgentResult>
  usage: Usage
  duration: number
}

// ── Embedding ────────────────────────────────────────────────────────────────

export interface EmbeddingResponse {
  embeddings: number[][]
  model: string
  usage: { totalTokens: number }
}

// ── Provider ─────────────────────────────────────────────────────────────────

export interface AIProvider {
  readonly name: string
  complete(request: CompletionRequest): Promise<CompletionResponse>
  stream(request: CompletionRequest): AsyncIterable<StreamChunk>
  embed?(input: string | string[], model?: string): Promise<EmbeddingResponse>
}

// ── Hooks ────────────────────────────────────────────────────────────────────

export type BeforeHook = (request: CompletionRequest) => void | Promise<void>
export type AfterHook = (
  request: CompletionRequest,
  response: CompletionResponse
) => void | Promise<void>

// ── Config ───────────────────────────────────────────────────────────────────

export interface ProviderConfig {
  driver: string
  apiKey: string
  model: string
  baseUrl?: string
  maxTokens?: number
  temperature?: number
  maxRetries?: number
  retryBaseDelay?: number
}

export interface BrainConfig {
  default: string
  providers: Record<string, ProviderConfig>
  maxTokens: number
  temperature: number
  maxIterations: number
  memory?: import('./memory/types.ts').MemoryConfig
}

// ── Serialized Thread ────────────────────────────────────────────────────────

export interface SerializedThread {
  messages: Message[]
  system?: string
}
