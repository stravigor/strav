import { describe, test, expect, afterEach } from 'bun:test'
import { GoogleProvider } from '../src/providers/google_provider.ts'
import type { Message } from '../src/types.ts'

const originalFetch = globalThis.fetch

function mockFetch(response: any, status = 200) {
  globalThis.fetch = async (url: any, init: any) => {
    ;(globalThis.fetch as any).__lastCall = { url: String(url), init }
    return new Response(JSON.stringify(response), {
      status,
      headers: { 'content-type': 'application/json' },
    })
  }
}

function mockStreamFetch(events: Array<{ event?: string; data: string }>) {
  globalThis.fetch = async (url: any, init: any) => {
    ;(globalThis.fetch as any).__lastCall = { url: String(url), init }
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        for (const sse of events) {
          if (sse.event) controller.enqueue(encoder.encode(`event: ${sse.event}\n`))
          controller.enqueue(encoder.encode(`data: ${sse.data}\n\n`))
        }
        controller.close()
      },
    })
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
}

function lastFetchCall() {
  return (globalThis.fetch as any).__lastCall as { url: string; init: any }
}

function lastFetchBody() {
  return JSON.parse(lastFetchCall().init.body)
}

async function collectStream(provider: GoogleProvider, request: any) {
  const chunks: any[] = []
  for await (const chunk of provider.stream(request)) {
    chunks.push(chunk)
  }
  return chunks
}

describe('GoogleProvider', () => {
  const provider = new GoogleProvider({
    driver: 'google',
    apiKey: 'test-api-key',
    model: 'gemini-2.0-flash',
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  // ── Request mapping ──────────────────────────────────────────────────────

  test('sends correct headers', async () => {
    mockFetch({
      candidates: [{
        content: { parts: [{ text: 'Hello' }] },
        finishReason: 'STOP'
      }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3, totalTokenCount: 8 }
    })

    await provider.complete({ model: 'gemini-2.0-flash', messages: [{ role: 'user', content: 'hi' }] })

    const { init } = lastFetchCall()
    expect(init.headers['x-goog-api-key']).toBe('test-api-key')
    expect(init.headers['content-type']).toBe('application/json')
  })

  test('sends correct endpoint URL for completion', async () => {
    mockFetch({
      candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 }
    })

    await provider.complete({ model: 'gemini-2.0-flash', messages: [{ role: 'user', content: 'hi' }] })

    expect(lastFetchCall().url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent')
  })

  test('sends correct endpoint URL for streaming', async () => {
    mockStreamFetch([
      { data: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }] }) }
    ])

    await collectStream(provider, { model: 'gemini-2.0-flash', messages: [{ role: 'user', content: 'hi' }] })

    expect(lastFetchCall().url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:streamGenerateContent')
  })

  test('uses custom baseUrl', async () => {
    const custom = new GoogleProvider({
      driver: 'google',
      apiKey: 'k',
      model: 'gemini-2.0-flash',
      baseUrl: 'https://custom-api.example.com/'
    })
    mockFetch({
      candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 }
    })

    await custom.complete({ model: 'gemini-2.0-flash', messages: [{ role: 'user', content: 'hi' }] })

    expect(lastFetchCall().url).toBe('https://custom-api.example.com/models/gemini-2.0-flash:generateContent')
  })

  test('defaults name to google', () => {
    expect(provider.name).toBe('google')
  })

  test('maps system prompt to systemInstruction', async () => {
    mockFetch({
      candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 }
    })

    await provider.complete({
      model: 'gemini-2.0-flash',
      messages: [{ role: 'user', content: 'hi' }],
      system: 'You are helpful.',
    })

    const body = lastFetchBody()
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'You are helpful.' }] })
  })

  test('maps tools to functionDeclarations format', async () => {
    mockFetch({
      candidates: [{ content: { parts: [] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 }
    })

    await provider.complete({
      model: 'gemini-2.0-flash',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        {
          name: 'get_weather',
          description: 'Get weather',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
          execute: async () => {},
        },
      ],
    })

    const body = lastFetchBody()
    expect(body.tools).toEqual([{
      functionDeclarations: [{
        name: 'get_weather',
        description: 'Get weather',
        parameters: { type: 'object', properties: { city: { type: 'string' } } }
      }]
    }])
  })

  test('maps toolChoice configurations', async () => {
    mockFetch({
      candidates: [{ content: { parts: [] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 }
    })

    // Test auto
    await provider.complete({
      model: 'gemini-2.0-flash',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'test', description: 'test', parameters: {}, execute: async () => {} }],
      toolChoice: 'auto',
    })
    expect(lastFetchBody().toolConfig).toEqual({
      functionCallingConfig: { mode: 'AUTO' }
    })

    // Test required
    await provider.complete({
      model: 'gemini-2.0-flash',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'test', description: 'test', parameters: {}, execute: async () => {} }],
      toolChoice: 'required',
    })
    expect(lastFetchBody().toolConfig).toEqual({
      functionCallingConfig: { mode: 'ANY' }
    })

    // Test specific tool
    await provider.complete({
      model: 'gemini-2.0-flash',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ name: 'search', description: 'search', parameters: {}, execute: async () => {} }],
      toolChoice: { name: 'search' },
    })
    expect(lastFetchBody().toolConfig).toEqual({
      functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['search'] }
    })
  })

  test('maps structured output to generationConfig', async () => {
    mockFetch({
      candidates: [{ content: { parts: [{ text: '{}' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 }
    })

    const schema = { type: 'object', properties: { name: { type: 'string' } } }
    await provider.complete({
      model: 'gemini-2.0-flash',
      messages: [{ role: 'user', content: 'hi' }],
      schema,
    })

    const body = lastFetchBody()
    expect(body.generationConfig).toEqual({
      responseMimeType: 'application/json',
      responseSchema: schema
    })
  })

  test('sends maxOutputTokens from request', async () => {
    mockFetch({
      candidates: [{ content: { parts: [] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 }
    })

    await provider.complete({
      model: 'gemini-2.0-flash',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 2000,
    })

    expect(lastFetchBody().generationConfig.maxOutputTokens).toBe(2000)
  })

  test('sends temperature and stop sequences', async () => {
    mockFetch({
      candidates: [{ content: { parts: [] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 }
    })

    await provider.complete({
      model: 'gemini-2.0-flash',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.7,
      stopSequences: ['STOP', 'END'],
    })

    const config = lastFetchBody().generationConfig
    expect(config.temperature).toBe(0.7)
    expect(config.stopSequences).toEqual(['STOP', 'END'])
  })

  // ── Message mapping ─────────────────────────────────────────────────────

  test('maps user messages to contents', async () => {
    mockFetch({
      candidates: [{ content: { parts: [] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 }
    })

    await provider.complete({
      model: 'gemini-2.0-flash',
      messages: [{ role: 'user', content: 'hello world' }],
    })

    const contents = lastFetchBody().contents
    expect(contents[0]).toEqual({
      role: 'user',
      parts: [{ text: 'hello world' }]
    })
  })

  test('maps assistant messages with text', async () => {
    mockFetch({
      candidates: [{ content: { parts: [] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 }
    })

    const messages: Message[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hello there!' },
      { role: 'user', content: 'more' },
    ]

    await provider.complete({ model: 'gemini-2.0-flash', messages })

    const contents = lastFetchBody().contents
    expect(contents[1]).toEqual({
      role: 'model',
      parts: [{ text: 'Hello there!' }]
    })
  })

  test('maps assistant messages with tool calls', async () => {
    mockFetch({
      candidates: [{ content: { parts: [] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 }
    })

    const messages: Message[] = [
      { role: 'user', content: 'search' },
      {
        role: 'assistant',
        content: 'Searching...',
        toolCalls: [{ id: 'call_1', name: 'search', arguments: { q: 'test' } }],
      },
    ]

    await provider.complete({ model: 'gemini-2.0-flash', messages })

    const contents = lastFetchBody().contents
    expect(contents[1]).toEqual({
      role: 'model',
      parts: [
        { text: 'Searching...' },
        { functionCall: { name: 'search', args: { q: 'test' } } }
      ]
    })
  })

  test('maps tool results to functionResponse', async () => {
    mockFetch({
      candidates: [{ content: { parts: [] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 }
    })

    const messages: Message[] = [
      { role: 'user', content: 'search' },
      {
        role: 'assistant',
        content: 'Searching...',
        toolCalls: [{ id: 'call_1', name: 'search', arguments: { q: 'test' } }],
      },
      { role: 'tool', toolCallId: 'call_1', content: 'search results' },
    ]

    await provider.complete({ model: 'gemini-2.0-flash', messages })

    const contents = lastFetchBody().contents
    expect(contents[2]).toEqual({
      role: 'user',
      parts: [{
        functionResponse: {
          name: 'search',
          response: { content: 'search results' }
        }
      }]
    })
  })

  // ── Response parsing ────────────────────────────────────────────────────

  test('parses text response', async () => {
    mockFetch({
      candidates: [{
        content: { parts: [{ text: 'Hello world' }] },
        finishReason: 'STOP'
      }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 }
    })

    const response = await provider.complete({
      model: 'gemini-2.0-flash',
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(response.content).toBe('Hello world')
    expect(response.toolCalls).toHaveLength(0)
    expect(response.stopReason).toBe('end')
    expect(response.usage).toEqual({ inputTokens: 10, outputTokens: 5, totalTokens: 15 })
  })

  test('parses function calls', async () => {
    mockFetch({
      candidates: [{
        content: {
          parts: [{ functionCall: { id: 'call_1', name: 'search', args: { query: 'test' } } }]
        },
        finishReason: 'STOP'
      }],
      usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 15, totalTokenCount: 35 }
    })

    const response = await provider.complete({
      model: 'gemini-2.0-flash',
      messages: [{ role: 'user', content: 'search' }],
    })

    expect(response.toolCalls).toHaveLength(1)
    expect(response.toolCalls[0]!.id).toBe('call_1')
    expect(response.toolCalls[0]!.name).toBe('search')
    expect(response.toolCalls[0]!.arguments).toEqual({ query: 'test' })
    expect(response.stopReason).toBe('tool_use')
  })

  test('parses mixed text and function calls', async () => {
    mockFetch({
      candidates: [{
        content: {
          parts: [
            { text: 'Let me search for that.' },
            { functionCall: { id: 'call_1', name: 'search', args: { q: 'test' } } }
          ]
        },
        finishReason: 'STOP'
      }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 }
    })

    const response = await provider.complete({
      model: 'gemini-2.0-flash',
      messages: [{ role: 'user', content: 'search' }],
    })

    expect(response.content).toBe('Let me search for that.')
    expect(response.toolCalls).toHaveLength(1)
    expect(response.stopReason).toBe('tool_use')
  })

  test('maps finish reasons correctly', async () => {
    // STOP → 'end'
    mockFetch({
      candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 }
    })
    let response = await provider.complete({
      model: 'gemini-2.0-flash',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(response.stopReason).toBe('end')

    // MAX_TOKENS → 'max_tokens'
    mockFetch({
      candidates: [{ content: { parts: [{ text: 'partial' }] }, finishReason: 'MAX_TOKENS' }],
      usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 }
    })
    response = await provider.complete({
      model: 'gemini-2.0-flash',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(response.stopReason).toBe('max_tokens')

    // SAFETY → 'stop_sequence'
    mockFetch({
      candidates: [{ content: { parts: [{ text: 'blocked' }] }, finishReason: 'SAFETY' }],
      usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 }
    })
    response = await provider.complete({
      model: 'gemini-2.0-flash',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(response.stopReason).toBe('stop_sequence')
  })

  // ── Streaming ────────────────────────────────────────────────────────────

  test('streams text content', async () => {
    mockStreamFetch([
      { data: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Hello' }] } }] }) },
      { data: JSON.stringify({ candidates: [{ content: { parts: [{ text: ' world' }] } }] }) },
      {
        data: JSON.stringify({
          candidates: [{ finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 }
        })
      },
    ])

    const chunks = await collectStream(provider, {
      model: 'gemini-2.0-flash',
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(chunks[0]).toEqual({ type: 'text', text: 'Hello' })
    expect(chunks[1]).toEqual({ type: 'text', text: ' world' })
    expect(chunks[2]).toEqual({
      type: 'usage',
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
    })
    expect(chunks[3]).toEqual({ type: 'done' })
  })

  test('streams function calls', async () => {
    mockStreamFetch([
      {
        data: JSON.stringify({
          candidates: [{
            content: { parts: [{ functionCall: { id: 'call_1', name: 'search', args: { query: 'test' } } }] }
          }]
        })
      },
      {
        data: JSON.stringify({
          candidates: [{ finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 }
        })
      },
    ])

    const chunks = await collectStream(provider, {
      model: 'gemini-2.0-flash',
      messages: [{ role: 'user', content: 'search' }],
    })

    expect(chunks[0]).toEqual({
      type: 'tool_start',
      toolCall: { id: 'call_1', name: 'search' },
      toolIndex: 0,
    })
    expect(chunks[1]).toEqual({ type: 'tool_end', toolIndex: 0 })
    expect(chunks[2].type).toBe('usage')
    expect(chunks[3]).toEqual({ type: 'done' })
  })

  test('stream skips unparseable data', async () => {
    mockStreamFetch([
      { data: 'not json' },
      { data: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }) },
      {
        data: JSON.stringify({
          candidates: [{ finishReason: 'STOP' }],
          usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 }
        })
      },
    ])

    const chunks = await collectStream(provider, {
      model: 'gemini-2.0-flash',
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(chunks[0]).toEqual({ type: 'text', text: 'ok' })
  })

  // ── Embedding ───────────────────────────────────────────────────────────

  test('embeds single text input', async () => {
    mockFetch({
      embedding: { values: [0.1, 0.2, 0.3] }
    })

    const response = await provider.embed('hello world')

    expect(response.embeddings).toEqual([[0.1, 0.2, 0.3]])
    expect(response.model).toBe('text-embedding-004')
    expect(lastFetchCall().url).toBe('https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent')
  })

  test('embeds multiple text inputs', async () => {
    let callCount = 0
    globalThis.fetch = async (url: any, init: any) => {
      callCount++
      const embedding = callCount === 1 ? [0.1, 0.2] : [0.3, 0.4]
      return new Response(JSON.stringify({ embedding: { values: embedding } }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      })
    }

    const response = await provider.embed(['hello', 'world'])

    expect(response.embeddings).toEqual([[0.1, 0.2], [0.3, 0.4]])
    expect(callCount).toBe(2)
  })

  test('uses custom embedding model', async () => {
    mockFetch({ embedding: { values: [0.1] } })

    await provider.embed('test', 'custom-embedding-model')

    expect(lastFetchCall().url).toBe('https://generativelanguage.googleapis.com/v1beta/models/custom-embedding-model:embedContent')
  })

  // ── Error handling ──────────────────────────────────────────────────────

  test('throws on non-2xx response', async () => {
    mockFetch({ error: { message: 'invalid api key' } }, 401)

    await expect(
      provider.complete({ model: 'gemini-2.0-flash', messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toThrow('Google error (401)')
  })

  test('throws when no candidates in response', async () => {
    mockFetch({ candidates: [] })

    await expect(
      provider.complete({ model: 'gemini-2.0-flash', messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toThrow('No candidates in response')
  })

  test('throws when tool result has no matching function name', async () => {
    mockFetch({
      candidates: [{ content: { parts: [] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 0, candidatesTokenCount: 0, totalTokenCount: 0 }
    })

    const messages: Message[] = [
      { role: 'tool', toolCallId: 'unknown_id', content: 'result' },
    ]

    await expect(
      provider.complete({ model: 'gemini-2.0-flash', messages })
    ).rejects.toThrow('No function name found for tool call ID: unknown_id')
  })

  test('preserves raw response', async () => {
    const rawData = {
      candidates: [{ content: { parts: [{ text: 'hi' }] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 }
    }
    mockFetch(rawData)

    const response = await provider.complete({
      model: 'gemini-2.0-flash',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(response.raw).toEqual(rawData)
  })
})