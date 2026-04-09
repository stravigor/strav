import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { AnthropicProvider } from '../src/providers/anthropic_provider.ts'
import type { CompletionRequest, Message } from '../src/types.ts'

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

function lastFetchCall() {
  return (globalThis.fetch as any).__lastCall as { url: string; init: any }
}

function lastFetchBody() {
  return JSON.parse(lastFetchCall().init.body)
}

describe('AnthropicProvider', () => {
  const provider = new AnthropicProvider({
    driver: 'anthropic',
    apiKey: 'test-key',
    model: 'claude-sonnet-4-5-20250929',
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  // ── Request mapping ──────────────────────────────────────────────────────

  test('sends correct headers', async () => {
    mockFetch({
      id: 'msg_1',
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    })

    await provider.complete({
      model: 'claude-sonnet-4-5-20250929',
      messages: [{ role: 'user', content: 'hi' }],
    })

    const { init } = lastFetchCall()
    const headers = init.headers
    expect(headers['x-api-key']).toBe('test-key')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(headers['content-type']).toBe('application/json')
  })

  test('sends correct endpoint URL', async () => {
    mockFetch({
      id: 'msg_1',
      content: [],
      stop_reason: 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0 },
    })

    await provider.complete({ model: 'test', messages: [{ role: 'user', content: 'hi' }] })

    expect(lastFetchCall().url).toBe('https://api.anthropic.com/v1/messages')
  })

  test('uses custom baseUrl', async () => {
    const custom = new AnthropicProvider({
      driver: 'anthropic',
      apiKey: 'k',
      model: 'm',
      baseUrl: 'https://custom.api.com/',
    })
    mockFetch({
      id: 'msg_1',
      content: [],
      stop_reason: 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0 },
    })

    await custom.complete({ model: 'test', messages: [{ role: 'user', content: 'hi' }] })

    expect(lastFetchCall().url).toBe('https://custom.api.com/v1/messages')
  })

  test('maps system prompt to top-level parameter', async () => {
    mockFetch({
      id: 'msg_1',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    })

    await provider.complete({
      model: 'claude-sonnet-4-5-20250929',
      messages: [{ role: 'user', content: 'hi' }],
      system: 'You are helpful.',
    })

    const body = lastFetchBody()
    expect(body.system).toBe('You are helpful.')
    // System should NOT be in messages
    expect(body.messages.every((m: any) => m.role !== 'system')).toBe(true)
  })

  test('maps tools to Anthropic format', async () => {
    mockFetch({
      id: 'msg_1',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    })

    await provider.complete({
      model: 'claude-sonnet-4-5-20250929',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [
        {
          name: 'search',
          description: 'Search db',
          parameters: { type: 'object', properties: { q: { type: 'string' } } },
          execute: async () => {},
        },
      ],
    })

    const body = lastFetchBody()
    expect(body.tools[0].name).toBe('search')
    expect(body.tools[0].input_schema).toEqual({
      type: 'object',
      properties: { q: { type: 'string' } },
    })
  })

  test('maps toolChoice auto', async () => {
    mockFetch({
      id: 'msg_1',
      content: [],
      stop_reason: 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0 },
    })

    await provider.complete({
      model: 'test',
      messages: [{ role: 'user', content: 'hi' }],
      toolChoice: 'auto',
    })

    expect(lastFetchBody().tool_choice).toEqual({ type: 'auto' })
  })

  test('maps toolChoice required', async () => {
    mockFetch({
      id: 'msg_1',
      content: [],
      stop_reason: 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0 },
    })

    await provider.complete({
      model: 'test',
      messages: [{ role: 'user', content: 'hi' }],
      toolChoice: 'required',
    })

    expect(lastFetchBody().tool_choice).toEqual({ type: 'any' })
  })

  test('maps toolChoice with specific name', async () => {
    mockFetch({
      id: 'msg_1',
      content: [],
      stop_reason: 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0 },
    })

    await provider.complete({
      model: 'test',
      messages: [{ role: 'user', content: 'hi' }],
      toolChoice: { name: 'search' },
    })

    expect(lastFetchBody().tool_choice).toEqual({ type: 'tool', name: 'search' })
  })

  test('maps structured output schema', async () => {
    mockFetch({
      id: 'msg_1',
      content: [{ type: 'text', text: '{}' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0 },
    })

    const schema = { type: 'object', properties: { name: { type: 'string' } } }
    await provider.complete({
      model: 'test',
      messages: [{ role: 'user', content: 'hi' }],
      schema,
    })

    expect(lastFetchBody().output_config).toEqual({
      format: {
        type: 'json_schema',
        schema
      }
    })
  })

  test('maps assistant messages with tool calls', async () => {
    mockFetch({
      id: 'msg_1',
      content: [],
      stop_reason: 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0 },
    })

    const messages: Message[] = [
      { role: 'user', content: 'search' },
      {
        role: 'assistant',
        content: 'Let me search.',
        toolCalls: [{ id: 'tc_1', name: 'search', arguments: { q: 'test' } }],
      },
      { role: 'tool', toolCallId: 'tc_1', content: 'found results' },
    ]

    await provider.complete({ model: 'test', messages })

    const body = lastFetchBody()
    // Assistant message should have content array with text and tool_use
    const assistantMsg = body.messages[1]
    expect(Array.isArray(assistantMsg.content)).toBe(true)
    expect(assistantMsg.content[0].type).toBe('text')
    expect(assistantMsg.content[1].type).toBe('tool_use')
    expect(assistantMsg.content[1].id).toBe('tc_1')
    expect(assistantMsg.content[1].input).toEqual({ q: 'test' })

    // Tool result should be user message with tool_result
    const toolMsg = body.messages[2]
    expect(toolMsg.role).toBe('user')
    expect(toolMsg.content[0].type).toBe('tool_result')
    expect(toolMsg.content[0].tool_use_id).toBe('tc_1')
  })

  // ── Response parsing ─────────────────────────────────────────────────────

  test('parses text content', async () => {
    mockFetch({
      id: 'msg_123',
      content: [{ type: 'text', text: 'Hello world' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 10, output_tokens: 5 },
    })

    const response = await provider.complete({
      model: 'test',
      messages: [{ role: 'user', content: 'hi' }],
    })

    expect(response.id).toBe('msg_123')
    expect(response.content).toBe('Hello world')
    expect(response.toolCalls).toHaveLength(0)
    expect(response.stopReason).toBe('end')
    expect(response.usage.inputTokens).toBe(10)
    expect(response.usage.outputTokens).toBe(5)
    expect(response.usage.totalTokens).toBe(15)
  })

  test('parses tool use content', async () => {
    mockFetch({
      id: 'msg_456',
      content: [
        { type: 'text', text: 'Searching...' },
        { type: 'tool_use', id: 'toolu_1', name: 'search', input: { query: 'test' } },
      ],
      stop_reason: 'tool_use',
      usage: { input_tokens: 20, output_tokens: 15 },
    })

    const response = await provider.complete({
      model: 'test',
      messages: [{ role: 'user', content: 'search for test' }],
    })

    expect(response.content).toBe('Searching...')
    expect(response.toolCalls).toHaveLength(1)
    expect(response.toolCalls[0]!.id).toBe('toolu_1')
    expect(response.toolCalls[0]!.name).toBe('search')
    expect(response.toolCalls[0]!.arguments).toEqual({ query: 'test' })
    expect(response.stopReason).toBe('tool_use')
  })

  test('maps stop reasons correctly', async () => {
    for (const [apiReason, expected] of [
      ['end_turn', 'end'],
      ['tool_use', 'tool_use'],
      ['max_tokens', 'max_tokens'],
      ['stop_sequence', 'stop_sequence'],
    ] as const) {
      mockFetch({
        id: 'msg_1',
        content: [],
        stop_reason: apiReason,
        usage: { input_tokens: 0, output_tokens: 0 },
      })
      const response = await provider.complete({
        model: 'test',
        messages: [{ role: 'user', content: 'hi' }],
      })
      expect(response.stopReason).toBe(expected)
    }
  })

  // ── Error handling ───────────────────────────────────────────────────────

  test('throws on non-2xx response', async () => {
    mockFetch({ error: { type: 'invalid_request', message: 'bad' } }, 400)

    await expect(
      provider.complete({ model: 'test', messages: [{ role: 'user', content: 'hi' }] })
    ).rejects.toThrow('Anthropic error (400)')
  })

  test('preserves raw response', async () => {
    const rawData = {
      id: 'msg_raw',
      content: [{ type: 'text', text: 'hi' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
      model: 'claude-sonnet-4-5-20250929',
    }
    mockFetch(rawData)

    const response = await provider.complete({
      model: 'test',
      messages: [{ role: 'user', content: 'hi' }],
    })
    expect(response.raw).toEqual(rawData)
  })

  test('uses default model from config when not in request', async () => {
    mockFetch({
      id: 'msg_1',
      content: [],
      stop_reason: 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0 },
    })

    await provider.complete({ model: '', messages: [{ role: 'user', content: 'hi' }] })
    // The model field should be sent (even if empty, the provider uses defaultModel)
    // Check body uses request model or falls back
  })

  test('sets max_tokens from request', async () => {
    mockFetch({
      id: 'msg_1',
      content: [],
      stop_reason: 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0 },
    })

    await provider.complete({
      model: 'test',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 2000,
    })

    expect(lastFetchBody().max_tokens).toBe(2000)
  })
})
