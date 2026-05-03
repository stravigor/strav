import { parseSSE } from '../utils/sse_parser.ts'
import { retryableFetch, type RetryOptions } from '../utils/retry.ts'
import { ExternalServiceError } from '@strav/kernel'
import { scrubProviderError } from '../utils/error_scrub.ts'
import type {
  AIProvider,
  CompletionRequest,
  CompletionResponse,
  StreamChunk,
  ProviderConfig,
  Message,
  ToolCall,
  Usage,
} from '../types.ts'

/**
 * OpenAI Responses API provider (`/v1/responses`).
 *
 * Drop-in replacement for the Chat Completions provider.
 * Implements the same `AIProvider` interface so Thread, AgentRunner,
 * and all Brain helpers work unchanged.
 */
export class OpenAIResponsesProvider implements AIProvider {
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

  // ── Non-streaming completion ────────────────────────────────────────────

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const body = this.buildRequestBody(request, false)

    const response = await retryableFetch(
      'OpenAI',
      `${this.baseUrl}/v1/responses`,
      { method: 'POST', headers: this.buildHeaders(), body: JSON.stringify(body) },
      this.retryOptions
    )

    const data: any = await response.json()
    return this.parseResponse(data)
  }

  // ── Streaming completion ────────────────────────────────────────────────

  async *stream(request: CompletionRequest): AsyncIterable<StreamChunk> {
    const body = this.buildRequestBody(request, true)

    const response = await retryableFetch(
      'OpenAI',
      `${this.baseUrl}/v1/responses`,
      { method: 'POST', headers: this.buildHeaders(), body: JSON.stringify(body) },
      this.retryOptions
    )

    if (!response.body) {
      throw new ExternalServiceError('OpenAI', undefined, 'No stream body returned')
    }

    // Track function call items by output_index for tool_start/tool_delta mapping
    const toolIndexMap = new Map<number, { callId: string; name: string }>()
    let toolCounter = 0

    for await (const sse of parseSSE(response.body)) {
      const eventType = sse.event ?? ''
      let data: any

      try {
        data = JSON.parse(sse.data)
      } catch {
        continue
      }

      // ── Text content ──────────────────────────────────────────────
      if (eventType === 'response.output_text.delta') {
        yield { type: 'text', text: data.delta ?? '' }
        continue
      }

      // ── Function call start ───────────────────────────────────────
      if (eventType === 'response.output_item.added' && data.item?.type === 'function_call') {
        const index = toolCounter++
        toolIndexMap.set(data.output_index ?? index, {
          callId: data.item.call_id ?? '',
          name: data.item.name ?? '',
        })
        yield {
          type: 'tool_start',
          toolCall: { id: data.item.call_id ?? '', name: data.item.name ?? '' },
          toolIndex: index,
        }
        continue
      }

      // ── Function call argument deltas ─────────────────────────────
      if (eventType === 'response.function_call_arguments.delta') {
        // Map output_index to our sequential toolIndex
        const outputIdx = data.output_index ?? 0
        let toolIdx = 0
        for (const [oi] of toolIndexMap) {
          if (oi === outputIdx) break
          toolIdx++
        }
        yield { type: 'tool_delta', text: data.delta ?? '', toolIndex: toolIdx }
        continue
      }

      // ── Function call arguments done ──────────────────────────────
      if (eventType === 'response.function_call_arguments.done') {
        const outputIdx = data.output_index ?? 0
        let toolIdx = 0
        for (const [oi] of toolIndexMap) {
          if (oi === outputIdx) break
          toolIdx++
        }
        yield { type: 'tool_end', toolIndex: toolIdx }
        continue
      }

      // ── Response completed ────────────────────────────────────────
      if (eventType === 'response.completed') {
        const usage = data.response?.usage
        if (usage) {
          yield {
            type: 'usage',
            usage: {
              inputTokens: usage.input_tokens ?? 0,
              outputTokens: usage.output_tokens ?? 0,
              totalTokens: usage.total_tokens ?? 0,
            },
          }
        }
        yield { type: 'done' }
        break
      }

      // ── Error ─────────────────────────────────────────────────────
      if (eventType === 'error') {
        const message = typeof data.message === 'string' ? data.message : JSON.stringify(data)
        throw new ExternalServiceError('OpenAI', undefined, scrubProviderError(message))
      }
    }
  }

  // ── Private helpers ─────────────────────────────────────────────────────

  private buildHeaders(): Record<string, string> {
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${this.apiKey}`,
    }
  }

  private buildRequestBody(request: CompletionRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model ?? this.defaultModel,
      input: this.mapMessages(request.messages),
    }

    // System prompt → instructions
    if (request.system) {
      body.instructions = request.system
    }

    if (stream) body.stream = true
    if (request.maxTokens ?? this.defaultMaxTokens) {
      body.max_output_tokens = request.maxTokens ?? this.defaultMaxTokens
    }
    // Note: temperature is not supported by the Responses API for some models
    // if (request.temperature !== undefined) body.temperature = request.temperature
    if (request.stopSequences?.length) body.stop = request.stopSequences

    // Tools
    if (request.tools?.length) {
      body.tools = request.tools.map(t => ({
        type: 'function',
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      }))
    }

    // Tool choice
    if (request.toolChoice) {
      if (typeof request.toolChoice === 'string') {
        body.tool_choice = request.toolChoice
      } else {
        body.tool_choice = {
          type: 'function',
          name: request.toolChoice.name,
        }
      }
    }

    // Structured output
    if (request.schema) {
      body.text = {
        format: {
          type: 'json_schema',
          name: 'response',
          schema: request.schema,
          strict: true,
        },
      }
    }

    return body
  }

  /**
   * Translate Brain Message[] into Responses API input items.
   *
   * User messages → { role: 'user', content }
   * Assistant messages → assistant message item + separate function_call items
   * Tool messages → { type: 'function_call_output', call_id, output }
   */
  private mapMessages(messages: Message[]): any[] {
    const items: any[] = []

    for (const msg of messages) {
      if (msg.role === 'user') {
        items.push({
          role: 'user',
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        })
      } else if (msg.role === 'assistant') {
        const text = typeof msg.content === 'string' ? msg.content : ''

        // Add assistant message item (only if there's text content)
        if (text) {
          items.push({
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text }],
          })
        }

        // Add function_call items for any tool calls
        if (msg.toolCalls?.length) {
          for (const tc of msg.toolCalls) {
            items.push({
              type: 'function_call',
              call_id: tc.id,
              name: tc.name,
              arguments: JSON.stringify(tc.arguments),
            })
          }
        }
      } else if (msg.role === 'tool') {
        items.push({
          type: 'function_call_output',
          call_id: msg.toolCallId ?? '',
          output: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        })
      }
    }

    return items
  }

  /**
   * Parse a non-streaming Responses API response into Brain CompletionResponse.
   */
  private parseResponse(data: any): CompletionResponse {
    const output: any[] = data.output ?? []
    let content = ''
    const toolCalls: ToolCall[] = []

    for (const item of output) {
      if (item.type === 'message' && item.role === 'assistant') {
        for (const part of item.content ?? []) {
          if (part.type === 'output_text') {
            content += part.text ?? ''
          }
        }
      } else if (item.type === 'function_call') {
        let args: Record<string, unknown> = {}
        try {
          args = JSON.parse(item.arguments ?? '{}')
        } catch {
          args = item.arguments ? { _raw: item.arguments } : {}
        }
        toolCalls.push({
          id: item.call_id ?? item.id ?? '',
          name: item.name ?? '',
          arguments: args,
        })
      }
    }

    const usage: Usage = {
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
      totalTokens: data.usage?.total_tokens ?? 0,
    }

    let stopReason: CompletionResponse['stopReason'] = 'end'
    if (toolCalls.length > 0) {
      stopReason = 'tool_use'
    } else if (data.status === 'incomplete') {
      stopReason = 'max_tokens'
    }

    return { id: data.id ?? '', content, toolCalls, stopReason, usage, raw: data }
  }
}
