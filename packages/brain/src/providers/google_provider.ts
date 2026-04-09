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
  Usage,
} from '../types.ts'

/**
 * Google Gemini API provider.
 *
 * Translates the framework's normalized CompletionRequest/Response
 * to/from the Google Generative Language API wire format. Uses raw `fetch()`.
 */
export class GoogleProvider implements AIProvider {
  readonly name: string
  private apiKey: string
  private baseUrl: string
  private defaultModel: string
  private defaultMaxTokens?: number
  private retryOptions: RetryOptions
  private toolCallIdToNameMap: Map<string, string> = new Map()

  constructor(config: ProviderConfig) {
    this.name = 'google'
    this.apiKey = config.apiKey
    this.baseUrl = (config.baseUrl ?? 'https://generativelanguage.googleapis.com/v1beta').replace(/\/$/, '')
    this.defaultModel = config.model || 'gemini-2.0-flash'
    this.defaultMaxTokens = config.maxTokens
    this.retryOptions = {
      maxRetries: config.maxRetries ?? 3,
      baseDelay: config.retryBaseDelay ?? 1000,
    }
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const model = request.model ?? this.defaultModel
    const body = this.buildRequestBody(request, false)

    const response = await retryableFetch(
      'Google',
      `${this.baseUrl}/models/${model}:generateContent`,
      { method: 'POST', headers: this.buildHeaders(), body: JSON.stringify(body) },
      this.retryOptions
    )

    const data: any = await response.json()
    return this.parseResponse(data)
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamChunk> {
    const model = request.model ?? this.defaultModel
    const body = this.buildRequestBody(request, true)

    const response = await retryableFetch(
      'Google',
      `${this.baseUrl}/models/${model}:streamGenerateContent`,
      { method: 'POST', headers: this.buildHeaders(), body: JSON.stringify(body) },
      this.retryOptions
    )

    if (!response.body) {
      throw new ExternalServiceError('Google', undefined, 'No stream body returned')
    }

    let currentToolIndex = -1
    let currentToolCall: Partial<ToolCall> | null = null

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

      const candidate = parsed.candidates?.[0]
      if (!candidate) continue

      // Process content parts if they exist
      if (candidate.content?.parts) {
        for (const part of candidate.content.parts) {
          if (part.text) {
            // Text content
            yield { type: 'text', text: part.text }
          } else if (part.functionCall) {
            // Function call
            if (currentToolCall === null) {
              // Start of new tool call
              currentToolIndex++
              currentToolCall = {
                id: part.functionCall.id || this.generateToolCallId(),
                name: part.functionCall.name,
                arguments: part.functionCall.args || {}
              }

              yield {
                type: 'tool_start',
                toolCall: {
                  id: currentToolCall.id,
                  name: currentToolCall.name
                } as ToolCall,
                toolIndex: currentToolIndex,
              }
            }

            // If this is a complete function call, end it
            if (part.functionCall.name && part.functionCall.args) {
              yield { type: 'tool_end', toolIndex: currentToolIndex }
              currentToolCall = null
            }
          }
        }
      }

      // Check if this is the final chunk
      if (candidate.finishReason) {
        // Handle usage information in the final chunk
        if (parsed.usageMetadata) {
          const usage: Usage = {
            inputTokens: parsed.usageMetadata.promptTokenCount ?? 0,
            outputTokens: parsed.usageMetadata.candidatesTokenCount ?? 0,
            totalTokens: parsed.usageMetadata.totalTokenCount ?? 0,
          }
          yield { type: 'usage', usage }
        }

        yield { type: 'done' }
        break
      }
    }
  }

  async embed(input: string | string[], model?: string): Promise<EmbeddingResponse> {
    const embeddingModel = model ?? 'text-embedding-004'
    const inputs = Array.isArray(input) ? input : [input]

    const requests = inputs.map(text => ({
      model: `models/${embeddingModel}`,
      content: {
        parts: [{ text }]
      }
    }))

    const embeddings: number[][] = []

    // Process each input separately as Google's batch API might not be available
    for (const request of requests) {
      const response = await retryableFetch(
        'Google',
        `${this.baseUrl}/models/${embeddingModel}:embedContent`,
        { method: 'POST', headers: this.buildHeaders(), body: JSON.stringify(request) },
        this.retryOptions
      )

      const data: any = await response.json()
      if (data.embedding?.values) {
        embeddings.push(data.embedding.values)
      }
    }

    return {
      embeddings,
      model: embeddingModel,
      usage: { totalTokens: inputs.length * 10 } // Rough estimate, Google doesn't provide token count for embeddings
    }
  }

  // ── Private helpers ──────────────────────────────────────────────────────

  private buildHeaders(): Record<string, string> {
    return {
      'content-type': 'application/json',
      'x-goog-api-key': this.apiKey,
    }
  }

  private buildRequestBody(request: CompletionRequest, stream: boolean): Record<string, unknown> {
    const model = request.model ?? this.defaultModel

    const body: Record<string, unknown> = {
      contents: this.mapMessages(request.messages),
    }

    // Add system instruction if present
    if (request.system) {
      body.systemInstruction = {
        parts: [{ text: request.system }]
      }
    }

    // Generation config
    const generationConfig: Record<string, unknown> = {}

    if (request.maxTokens !== undefined) {
      generationConfig.maxOutputTokens = request.maxTokens
    } else if (this.defaultMaxTokens !== undefined) {
      generationConfig.maxOutputTokens = this.defaultMaxTokens
    }

    if (request.temperature !== undefined) {
      generationConfig.temperature = request.temperature
    }

    if (request.stopSequences?.length) {
      generationConfig.stopSequences = request.stopSequences
    }

    // Structured output
    if (request.schema) {
      generationConfig.responseMimeType = 'application/json'
      generationConfig.responseSchema = request.schema
    }

    if (Object.keys(generationConfig).length > 0) {
      body.generationConfig = generationConfig
    }

    // Tools (function declarations)
    if (request.tools?.length) {
      body.tools = [{
        functionDeclarations: request.tools.map(t => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        }))
      }]

      // Tool choice configuration
      if (request.toolChoice) {
        const toolConfig: Record<string, unknown> = {}

        if (request.toolChoice === 'auto') {
          toolConfig.functionCallingConfig = { mode: 'AUTO' }
        } else if (request.toolChoice === 'required') {
          toolConfig.functionCallingConfig = { mode: 'ANY' }
        } else if (typeof request.toolChoice === 'object' && request.toolChoice.name) {
          toolConfig.functionCallingConfig = {
            mode: 'ANY',
            allowedFunctionNames: [request.toolChoice.name]
          }
        }

        if (Object.keys(toolConfig).length > 0) {
          body.toolConfig = toolConfig
        }
      }
    }

    return body
  }

  private mapMessages(messages: Message[]): any[] {
    const result: any[] = []

    for (const msg of messages) {
      if (msg.role === 'tool') {
        // Tool results go as user messages with function response parts
        // Get the function name from our mapping
        const functionName = msg.toolCallId ? this.toolCallIdToNameMap.get(msg.toolCallId) : undefined

        if (!functionName) {
          throw new ExternalServiceError('Google', undefined, `No function name found for tool call ID: ${msg.toolCallId}`)
        }

        result.push({
          role: 'user',
          parts: [
            {
              functionResponse: {
                name: functionName,
                response: {
                  content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
                }
              }
            }
          ]
        })
      } else if (msg.role === 'assistant') {
        const parts: any[] = []

        // Add text content if present
        const text = typeof msg.content === 'string' ? msg.content : ''
        if (text) {
          parts.push({ text })
        }

        // Add function call parts and track their IDs
        if (msg.toolCalls?.length) {
          for (const tc of msg.toolCalls) {
            // Store the mapping for later use
            this.toolCallIdToNameMap.set(tc.id, tc.name)

            parts.push({
              functionCall: {
                name: tc.name,
                args: tc.arguments,
              }
            })
          }
        }

        result.push({
          role: 'model', // Gemini uses 'model' instead of 'assistant'
          parts
        })
      } else {
        // User messages
        result.push({
          role: 'user',
          parts: [{ text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) }]
        })
      }
    }

    return result
  }

  private parseResponse(data: any): CompletionResponse {
    const candidate = data.candidates?.[0]
    if (!candidate) {
      throw new ExternalServiceError('Google', undefined, 'No candidates in response')
    }

    let content = ''
    const toolCalls: ToolCall[] = []

    // Extract content from parts
    if (Array.isArray(candidate.content?.parts)) {
      for (const part of candidate.content.parts) {
        if (part.text) {
          content += part.text
        } else if (part.functionCall) {
          toolCalls.push({
            id: part.functionCall.id || this.generateToolCallId(),
            name: part.functionCall.name,
            arguments: part.functionCall.args || {},
          })
        }
      }
    }

    const usage: Usage = {
      inputTokens: data.usageMetadata?.promptTokenCount ?? 0,
      outputTokens: data.usageMetadata?.candidatesTokenCount ?? 0,
      totalTokens: data.usageMetadata?.totalTokenCount ?? 0,
    }

    let stopReason: CompletionResponse['stopReason'] = 'end'

    // Check tool calls first, as Google may return STOP even with tool calls
    if (toolCalls.length > 0) {
      stopReason = 'tool_use'
    } else {
      switch (candidate.finishReason) {
        case 'STOP':
          stopReason = 'end'
          break
        case 'MAX_TOKENS':
          stopReason = 'max_tokens'
          break
        case 'SAFETY':
        case 'RECITATION':
          stopReason = 'stop_sequence'
          break
      }
    }

    return {
      id: data.candidates?.[0]?.id || this.generateResponseId(),
      content,
      toolCalls,
      stopReason,
      usage,
      raw: data,
    }
  }

  private generateToolCallId(): string {
    return `tool_${Math.random().toString(36).substring(2, 15)}`
  }

  private generateResponseId(): string {
    return `resp_${Math.random().toString(36).substring(2, 15)}`
  }
}