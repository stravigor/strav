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
  type: 'text' | 'tool_start' | 'tool_result' | 'iteration' | 'done' | 'suspended'
  text?: string
  toolCall?: ToolCallRecord
  iteration?: number
  result?: AgentResult
  suspended?: SuspendedRun
}

// ── Suspend / Resume ─────────────────────────────────────────────────────────

/**
 * A JSON-serializable snapshot of an agent loop at the moment it suspended.
 *
 * All fields are plain data — no functions, class instances, or cycles — so
 * the snapshot can be stringified, stored across a process boundary, and
 * later passed to `AgentRunner.resume()` to continue the run.
 */
export interface SerializedAgentState {
  messages: Message[]
  allToolCalls: ToolCallRecord[]
  totalUsage: Usage
  iterations: number
}

/**
 * Result of an agent run that was suspended before executing one or more
 * tool calls. The integrator is expected to obtain tool results out-of-band
 * (human approval, external system, queued job, etc.) and call
 * `AgentRunner.resume(state, toolResults)` to continue.
 *
 * `pendingToolCalls` contains the pending call that triggered suspension
 * plus any subsequent tool calls from the same batch that have not been
 * executed. Results must be supplied for each of them on resume so the
 * conversation remains well-formed for the provider.
 */
export interface SuspendedRun {
  status: 'suspended'
  pendingToolCalls: ToolCall[]
  state: SerializedAgentState
}

/** Result of a pending tool call, supplied to `AgentRunner.resume()`. */
export interface ToolCallResult {
  toolCallId: string
  result: unknown
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

// ── Transcription (Speech-to-Text) ───────────────────────────────────────────

export interface TranscribeRequest {
  /** Audio bytes. Most STT endpoints cap at ~25MB; chunk longer recordings. */
  audio: Uint8Array | Blob
  /**
   * MIME type of the audio. Required for providers that infer format from
   * the multipart filename or rely on it for inline base64 (Gemini).
   * Examples: 'audio/m4a', 'audio/mpeg', 'audio/wav', 'audio/ogg',
   * 'audio/webm', 'audio/flac'.
   */
  contentType?: string
  /** Override the provider's default STT model. */
  model?: string
  /**
   * BCP-47 language hint (e.g. 'th', 'en', 'zh'). Whisper accepts ISO-639-1
   * ('th'); Gemini uses BCP-47. Both improve accuracy when set; omit for
   * auto-detection.
   */
  language?: string
  /**
   * Optional priming prompt — gives the model vocabulary or context to
   * bias toward (proper nouns, brand names, menu items, dialect markers).
   * Whisper uses this directly; Gemini incorporates it into the system
   * instruction.
   */
  prompt?: string
  /**
   * Filename to send in the multipart form (Whisper). Used to derive the
   * audio format on the server when `contentType` is missing. Defaults to
   * 'audio.bin' if not provided.
   */
  filename?: string
}

export interface TranscriptionResponse {
  /** Transcribed text. */
  text: string
  /** Detected language, when the provider reports one. */
  language?: string
  /** Audio duration in seconds, when the provider reports one. */
  duration?: number
  /** Original provider response for callers that need provider-specific fields. */
  raw: unknown
}

// ── Provider ─────────────────────────────────────────────────────────────────

export interface AIProvider {
  readonly name: string
  complete(request: CompletionRequest): Promise<CompletionResponse>
  stream(request: CompletionRequest): AsyncIterable<StreamChunk>
  embed?(input: string | string[], model?: string): Promise<EmbeddingResponse>
  /**
   * Transcribe audio to text. Implemented by providers that expose a
   * speech-to-text endpoint (OpenAI Whisper, Google Gemini's multimodal
   * generateContent). Throws or remains undefined for providers without
   * STT (Anthropic at time of writing).
   */
  transcribe?(request: TranscribeRequest): Promise<TranscriptionResponse>
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
