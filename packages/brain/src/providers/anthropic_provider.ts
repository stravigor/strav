import { parseSSE } from '../utils/sse_parser.ts'
import { retryableFetch, type RetryOptions } from '../utils/retry.ts'
import { ExternalServiceError } from '@strav/kernel'
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
 * Anthropic Messages API provider.
 *
 * Translates the framework's normalized CompletionRequest/Response
 * to/from the Anthropic wire format. Uses raw `fetch()`.
 */
export class AnthropicProvider implements AIProvider {
  readonly name: string
  private apiKey: string
  private baseUrl: string
  private defaultModel: string
  private defaultMaxTokens: number
  private retryOptions: RetryOptions

  constructor(config: ProviderConfig) {
    this.name = 'anthropic'
    this.apiKey = config.apiKey
    this.baseUrl = (config.baseUrl ?? 'https://api.anthropic.com').replace(/\/$/, '')
    this.defaultModel = config.model
    this.defaultMaxTokens = config.maxTokens ?? 4096
    this.retryOptions = {
      maxRetries: config.maxRetries ?? 3,
      baseDelay: config.retryBaseDelay ?? 1000,
    }
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const body = this.buildRequestBody(request, false)

    const response = await retryableFetch(
      'Anthropic',
      `${this.baseUrl}/v1/messages`,
      { method: 'POST', headers: this.buildHeaders(), body: JSON.stringify(body) },
      this.retryOptions
    )

    const data: any = await response.json()
    return this.parseResponse(data)
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamChunk> {
    const body = this.buildRequestBody(request, true)

    const response = await retryableFetch(
      'Anthropic',
      `${this.baseUrl}/v1/messages`,
      { method: 'POST', headers: this.buildHeaders(), body: JSON.stringify(body) },
      this.retryOptions
    )

    if (!response.body) {
      throw new ExternalServiceError('Anthropic', undefined, 'No stream body returned')
    }

    let currentBlockIndex = -1

    for await (const sse of parseSSE(response.body)) {
      if (sse.data === '[DONE]') break

      let parsed: any
      try {
        parsed = JSON.parse(sse.data)
      } catch {
        continue
      }

      const type = parsed.type ?? sse.event

      if (type === 'content_block_start') {
        currentBlockIndex = parsed.index ?? currentBlockIndex + 1
        const block = parsed.content_block
        if (block?.type === 'tool_use') {
          yield {
            type: 'tool_start',
            toolCall: { id: block.id, name: block.name },
            toolIndex: currentBlockIndex,
          }
        }
      } else if (type === 'content_block_delta') {
        const delta = parsed.delta
        if (delta?.type === 'text_delta') {
          yield { type: 'text', text: delta.text }
        } else if (delta?.type === 'input_json_delta') {
          yield {
            type: 'tool_delta',
            text: delta.partial_json,
            toolIndex: parsed.index ?? currentBlockIndex,
          }
        }
      } else if (type === 'content_block_stop') {
        // If we were accumulating a tool call, signal end
        if (currentBlockIndex >= 0) {
          yield { type: 'tool_end', toolIndex: parsed.index ?? currentBlockIndex }
        }
      } else if (type === 'message_delta') {
        const usage = parsed.usage
        if (usage) {
          yield {
            type: 'usage',
            usage: {
              inputTokens: usage.input_tokens ?? 0,
              outputTokens: usage.output_tokens ?? 0,
              totalTokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
            },
          }
        }
      } else if (type === 'message_stop') {
        yield { type: 'done' }
      }
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private buildHeaders(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01',
    }
  }

  private buildRequestBody(request: CompletionRequest, stream: boolean): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: request.model ?? this.defaultModel,
      max_tokens: request.maxTokens ?? this.defaultMaxTokens,
      messages: this.mapMessages(request.messages),
    }

    if (stream) body.stream = true
    if (request.system) body.system = request.system
    if (request.temperature !== undefined) body.temperature = request.temperature
    if (request.stopSequences?.length) body.stop_sequences = request.stopSequences

    // Tools
    if (request.tools?.length) {
      body.tools = request.tools.map(t => ({
        name: t.name,
        description: t.description,
        input_schema: t.parameters,
      }))
    }

    // Tool choice
    if (request.toolChoice) {
      if (request.toolChoice === 'auto') {
        body.tool_choice = { type: 'auto' }
      } else if (request.toolChoice === 'required') {
        body.tool_choice = { type: 'any' }
      } else {
        body.tool_choice = { type: 'tool', name: request.toolChoice.name }
      }
    }

    // Structured output (using GA API with output_config)
    if (request.schema) {
      body.output_config = {
        format: {
          type: 'json_schema',
          schema: request.schema
        }
      }
    }

    return body
  }

  private mapMessages(messages: Message[]): any[] {
    const result: any[] = []

    for (const msg of messages) {
      if (msg.role === 'tool') {
        // Tool results go as user messages with tool_result content blocks
        result.push({
          role: 'user',
          content: [
            {
              type: 'tool_result',
              tool_use_id: msg.toolCallId,
              content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
            },
          ],
        })
      } else if (msg.role === 'assistant') {
        const content: any[] = []

        // Add text content if present
        const text = typeof msg.content === 'string' ? msg.content : ''
        if (text) {
          content.push({ type: 'text', text })
        }

        // Add tool use blocks
        if (msg.toolCalls?.length) {
          for (const tc of msg.toolCalls) {
            content.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.name,
              input: tc.arguments,
            })
          }
        }

        result.push({
          role: 'assistant',
          content: content.length === 1 && content[0].type === 'text' ? content[0].text : content,
        })
      } else {
        // User messages
        result.push({
          role: 'user',
          content: typeof msg.content === 'string' ? msg.content : msg.content,
        })
      }
    }

    return result
  }

  private parseResponse(data: any): CompletionResponse {
    let content = ''
    const toolCalls: ToolCall[] = []

    if (Array.isArray(data.content)) {
      for (const block of data.content) {
        if (block.type === 'text') {
          content += block.text
        } else if (block.type === 'tool_use') {
          toolCalls.push({
            id: block.id,
            name: block.name,
            arguments: block.input ?? {},
          })
        }
      }
    }

    const usage: Usage = {
      inputTokens: data.usage?.input_tokens ?? 0,
      outputTokens: data.usage?.output_tokens ?? 0,
      totalTokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
    }

    let stopReason: CompletionResponse['stopReason'] = 'end'
    switch (data.stop_reason) {
      case 'tool_use':
        stopReason = 'tool_use'
        break
      case 'max_tokens':
        stopReason = 'max_tokens'
        break
      case 'stop_sequence':
        stopReason = 'stop_sequence'
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
}
