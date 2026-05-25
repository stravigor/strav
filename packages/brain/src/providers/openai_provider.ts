import { parseSSE } from '../utils/sse_parser.ts'
import { retryableFetch, type RetryOptions } from '../utils/retry.ts'
import { ExternalServiceError } from '@strav/kernel'
import type {
  AIProvider,
  CompletionRequest,
  CompletionResponse,
  StreamChunk,
  EmbeddingResponse,
  ProviderConfig,
  Message,
  ToolCall,
  TranscribeRequest,
  TranscriptionResponse,
  Usage,
} from '../types.ts'

/**
 * OpenAI Chat Completions API provider.
 *
 * Also serves DeepSeek and any OpenAI-compatible API by setting `baseUrl`
 * in the provider config. Uses raw `fetch()`.
 */
export class OpenAIProvider implements AIProvider {
  readonly name: string
  private apiKey: string
  private baseUrl: string
  private defaultModel: string
  private defaultMaxTokens?: number
  private retryOptions: RetryOptions

  constructor(config: ProviderConfig, name?: string) {
    this.name = name ?? 'openai'
    this.apiKey = config.apiKey
    this.baseUrl = (config.baseUrl ?? 'https://api.openai.com').replace(/\/$/, '')
    this.defaultModel = config.model
    this.defaultMaxTokens = config.maxTokens
    this.retryOptions = {
      maxRetries: config.maxRetries ?? 3,
      baseDelay: config.retryBaseDelay ?? 1000,
    }
  }

  /** Whether this provider supports OpenAI's native json_schema response format. */
  private get supportsJsonSchema(): boolean {
    return this.baseUrl === 'https://api.openai.com'
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const body = this.buildRequestBody(request, false)

    const response = await retryableFetch(
      'OpenAI',
      `${this.baseUrl}/v1/chat/completions`,
      { method: 'POST', headers: this.buildHeaders(), body: JSON.stringify(body) },
      this.retryOptions
    )

    const data: any = await response.json()
    return this.parseResponse(data)
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamChunk> {
    const body = this.buildRequestBody(request, true)

    const response = await retryableFetch(
      'OpenAI',
      `${this.baseUrl}/v1/chat/completions`,
      { method: 'POST', headers: this.buildHeaders(), body: JSON.stringify(body) },
      this.retryOptions
    )

    if (!response.body) {
      throw new ExternalServiceError('OpenAI', undefined, 'No stream body returned')
    }

    // Track in-progress tool calls for tool_start vs tool_delta distinction
    const seenTools = new Set<number>()

    for await (const sse of parseSSE(response.body)) {
      if (sse.data === '[DONE]') {
        yield { type: 'done' }
        break
      }

      let parsed: any
      try {
        parsed = JSON.parse(sse.data)
      } catch {
        continue
      }

      const choice = parsed.choices?.[0]
      if (!choice) continue

      const delta = choice.delta
      if (!delta) continue

      // Text content
      if (delta.content) {
        yield { type: 'text', text: delta.content }
      }

      // Tool calls
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const index: number = tc.index ?? 0

          if (!seenTools.has(index)) {
            // First chunk for this tool — emit tool_start
            seenTools.add(index)
            yield {
              type: 'tool_start',
              toolCall: { id: tc.id, name: tc.function?.name },
              toolIndex: index,
            }
          }

          // Argument fragments
          if (tc.function?.arguments) {
            yield {
              type: 'tool_delta',
              text: tc.function.arguments,
              toolIndex: index,
            }
          }
        }
      }

      // Finish reason
      if (choice.finish_reason) {
        if (choice.finish_reason === 'tool_calls') {
          // Emit tool_end for all tracked tools
          for (const idx of seenTools) {
            yield { type: 'tool_end', toolIndex: idx }
          }
        }

        // Usage in final chunk (if stream_options.include_usage is set)
        if (parsed.usage) {
          yield {
            type: 'usage',
            usage: {
              inputTokens: parsed.usage.prompt_tokens ?? 0,
              outputTokens: parsed.usage.completion_tokens ?? 0,
              totalTokens: parsed.usage.total_tokens ?? 0,
            },
          }
        }
      }
    }
  }

  async embed(input: string | string[], model?: string): Promise<EmbeddingResponse> {
    const body = {
      input: Array.isArray(input) ? input : [input],
      model: model ?? 'text-embedding-3-small',
    }

    const response = await retryableFetch(
      'OpenAI',
      `${this.baseUrl}/v1/embeddings`,
      { method: 'POST', headers: this.buildHeaders(), body: JSON.stringify(body) },
      this.retryOptions
    )

    const data: any = await response.json()

    return {
      embeddings: data.data.map((d: any) => d.embedding),
      model: data.model,
      usage: { totalTokens: data.usage?.total_tokens ?? 0 },
    }
  }

  /**
   * Speech-to-text via the OpenAI Whisper API (/v1/audio/transcriptions).
   *
   * Defaults to `whisper-1` — the long-standing, broadly supported model.
   * Override with `gpt-4o-transcribe` or `gpt-4o-mini-transcribe` for the
   * newer architecture (better noise/accent robustness, similar pricing).
   *
   * Requests `verbose_json` so we can surface `language` and `duration`
   * on the normalized response without a second round-trip.
   */
  async transcribe(request: TranscribeRequest): Promise<TranscriptionResponse> {
    const filename = request.filename ?? defaultFilename(request.contentType)
    const contentType = request.contentType ?? 'application/octet-stream'
    const blob =
      request.audio instanceof Blob
        ? request.audio
        : new Blob([request.audio], { type: contentType })

    const form = new FormData()
    form.append('file', blob, filename)
    form.append('model', request.model ?? 'whisper-1')
    form.append('response_format', 'verbose_json')
    if (request.language) form.append('language', request.language)
    if (request.prompt) form.append('prompt', request.prompt)

    const response = await retryableFetch(
      'OpenAI',
      `${this.baseUrl}/v1/audio/transcriptions`,
      {
        method: 'POST',
        // Don't set Content-Type — the runtime sets it with the
        // multipart boundary derived from the FormData body.
        headers: { Authorization: `Bearer ${this.apiKey}` },
        body: form,
      },
      this.retryOptions
    )

    const data: any = await response.json()
    return {
      text: String(data.text ?? ''),
      language: typeof data.language === 'string' ? data.language : undefined,
      duration: typeof data.duration === 'number' ? data.duration : undefined,
      raw: data,
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private isReasoningModel(model: string): boolean {
    return /^(o[1-9]|gpt-5)/.test(model)
  }

  private usesMaxCompletionTokens(model: string): boolean {
    return this.isReasoningModel(model) || /^gpt-4\.1|gpt-4o-mini-2024/.test(model)
  }

  private buildHeaders(): Record<string, string> {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${this.apiKey}`,
    }
  }

  private buildRequestBody(request: CompletionRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model ?? this.defaultModel,
      messages: this.mapMessages(request.messages, request.system),
    }

    if (stream) body.stream = true
    if (request.maxTokens ?? this.defaultMaxTokens) {
      const tokens = request.maxTokens ?? this.defaultMaxTokens
      const model = (body.model as string) ?? ''

      if (this.usesMaxCompletionTokens(model)) {
        body.max_completion_tokens = tokens
      } else {
        body.max_tokens = tokens
      }
    }
    if (request.temperature !== undefined && !this.isReasoningModel((body.model as string) ?? '')) {
      body.temperature = request.temperature
    }
    if (request.stopSequences?.length) body.stop = request.stopSequences

    // Tools
    if (request.tools?.length) {
      body.tools = request.tools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }))
    }

    // Tool choice
    if (request.toolChoice) {
      if (typeof request.toolChoice === 'string') {
        body.tool_choice = request.toolChoice
      } else {
        body.tool_choice = {
          type: 'function',
          function: { name: request.toolChoice.name },
        }
      }
    }

    // Structured output
    if (request.schema) {
      const useStrict = this.supportsJsonSchema && this.isStrictCompatible(request.schema)

      if (useStrict) {
        body.response_format = {
          type: 'json_schema',
          json_schema: {
            name: 'response',
            schema: this.normalizeSchemaForOpenAI(request.schema),
            strict: true,
          },
        }
      } else {
        // Fallback: json_object mode with schema injected into system prompt
        body.response_format = { type: 'json_object' }
        const schemaHint = `\n\nYou MUST respond with valid JSON matching this schema:\n${JSON.stringify(request.schema, null, 2)}`
        const messages = body.messages as any[]
        if (messages[0]?.role === 'system') {
          messages[0].content += schemaHint
        } else {
          messages.unshift({ role: 'system', content: `Respond with valid JSON.${schemaHint}` })
        }
      }
    }

    return body
  }

  private mapMessages(messages: Message[], system?: string): any[] {
    const result: any[] = []

    // System prompt as first message
    if (system) {
      result.push({ role: 'system', content: system })
    }

    for (const msg of messages) {
      if (msg.role === 'tool') {
        result.push({
          role: 'tool',
          tool_call_id: msg.toolCallId,
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        })
      } else if (msg.role === 'assistant') {
        const mapped: any = {
          role: 'assistant',
          content: typeof msg.content === 'string' ? msg.content : null,
        }

        if (msg.toolCalls?.length) {
          mapped.tool_calls = msg.toolCalls.map(tc => ({
            id: tc.id,
            type: 'function',
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            },
          }))
        }

        result.push(mapped)
      } else {
        result.push({
          role: 'user',
          content: typeof msg.content === 'string' ? msg.content : msg.content,
        })
      }
    }

    return result
  }

  private parseResponse(data: any): CompletionResponse {
    const choice = data.choices?.[0]
    const message = choice?.message

    const content: string = message?.content ?? ''
    const toolCalls: ToolCall[] = []

    if (message?.tool_calls) {
      for (const tc of message.tool_calls) {
        let args: Record<string, unknown> = {}
        try {
          args = JSON.parse(tc.function.arguments)
        } catch {
          // Invalid JSON from the model — pass as-is in a wrapper
          args = { _raw: tc.function.arguments }
        }

        toolCalls.push({
          id: tc.id,
          name: tc.function.name,
          arguments: args,
        })
      }
    }

    const usage: Usage = {
      inputTokens: data.usage?.prompt_tokens ?? 0,
      outputTokens: data.usage?.completion_tokens ?? 0,
      totalTokens: data.usage?.total_tokens ?? 0,
    }

    let stopReason: CompletionResponse['stopReason'] = 'end'
    switch (choice?.finish_reason) {
      case 'tool_calls':
        stopReason = 'tool_use'
        break
      case 'length':
        stopReason = 'max_tokens'
        break
      case 'stop':
        stopReason = 'end'
        break
    }

    return {
      id: data.id ?? '',
      content,
      toolCalls,
      stopReason,
      usage,
      raw: data,
    }
  }

  /**
   * OpenAI's strict structured output requires:
   * - All properties listed in `required`
   * - Optional properties use nullable types instead
   * - `additionalProperties: false` on every object
   */
  /**
   * Check if a schema is compatible with OpenAI's strict structured output.
   * Record types (object with additionalProperties != false) are not supported.
   */
  private isStrictCompatible(schema: Record<string, unknown>): boolean {
    if (schema == null || typeof schema !== 'object') return true

    // Record type: object with additionalProperties that isn't false
    if (
      schema.type === 'object' &&
      schema.additionalProperties !== undefined &&
      schema.additionalProperties !== false
    ) {
      return false
    }

    // Check nested properties
    if (schema.properties) {
      for (const prop of Object.values(schema.properties as Record<string, any>)) {
        if (!this.isStrictCompatible(prop)) return false
      }
    }

    // Check array items
    if (schema.items && !this.isStrictCompatible(schema.items as Record<string, unknown>))
      return false

    // Check anyOf / oneOf
    for (const key of ['anyOf', 'oneOf'] as const) {
      if (Array.isArray(schema[key])) {
        for (const s of schema[key] as any[]) {
          if (!this.isStrictCompatible(s)) return false
        }
      }
    }

    return true
  }

  /** Keywords OpenAI strict mode does NOT support. */
  private static UNSUPPORTED_KEYWORDS = new Set([
    'propertyNames',
    'patternProperties',
    'if',
    'then',
    'else',
    'not',
    'contains',
    'minItems',
    'maxItems',
    'minProperties',
    'maxProperties',
    'minLength',
    'maxLength',
    'minimum',
    'maximum',
    'exclusiveMinimum',
    'exclusiveMaximum',
    'multipleOf',
    'pattern',
    'format',
    'contentEncoding',
    'contentMediaType',
    'unevaluatedProperties',
    '$schema',
  ])

  private normalizeSchemaForOpenAI(schema: Record<string, unknown>): Record<string, unknown> {
    if (schema == null || typeof schema !== 'object') return schema

    // Strip unsupported keywords
    const result: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(schema)) {
      if (!OpenAIProvider.UNSUPPORTED_KEYWORDS.has(k)) {
        result[k] = v
      }
    }

    // Handle object types with explicit properties
    if (result.type === 'object' && result.properties) {
      const props = result.properties as Record<string, any>
      const currentRequired = new Set(
        Array.isArray(result.required) ? (result.required as string[]) : []
      )

      const normalizedProps: Record<string, any> = {}

      for (const [key, prop] of Object.entries(props)) {
        let normalizedProp = this.normalizeSchemaForOpenAI(prop)

        // If property is not required, make it nullable and add to required
        if (!currentRequired.has(key)) {
          normalizedProp = this.makeNullable(normalizedProp)
        }

        normalizedProps[key] = normalizedProp
      }

      result.properties = normalizedProps
      result.required = Object.keys(normalizedProps)
      result.additionalProperties = false
    }

    // Handle arrays
    if (result.type === 'array' && result.items) {
      result.items = this.normalizeSchemaForOpenAI(result.items as Record<string, unknown>)
    }

    // Handle anyOf / oneOf
    for (const key of ['anyOf', 'oneOf'] as const) {
      if (Array.isArray(result[key])) {
        result[key] = (result[key] as any[]).map((s: any) => this.normalizeSchemaForOpenAI(s))
      }
    }

    return result
  }

  private makeNullable(schema: Record<string, unknown>): Record<string, unknown> {
    // Already nullable
    if (Array.isArray(schema.type) && schema.type.includes('null')) return schema

    // Has anyOf — add null variant
    if (Array.isArray(schema.anyOf)) {
      const hasNull = schema.anyOf.some((s: any) => s.type === 'null')
      if (!hasNull) {
        return { ...schema, anyOf: [...schema.anyOf, { type: 'null' }] }
      }
      return schema
    }

    // Simple type — wrap in anyOf with null
    if (schema.type) {
      const { type, ...rest } = schema
      return { anyOf: [{ type, ...rest }, { type: 'null' }] }
    }

    return schema
  }
}

/**
 * Choose a multipart filename for Whisper based on the content type.
 * Whisper sniffs the extension when no MIME is supplied; sending a name
 * that matches the actual format avoids "unsupported file" 400s.
 */
function defaultFilename(contentType?: string): string {
  if (!contentType) return 'audio.bin'
  const ext = contentType.split('/')[1]?.split(';')[0]?.trim()
  return ext ? `audio.${ext}` : 'audio.bin'
}
