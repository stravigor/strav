import { describe, test, expect, beforeEach } from 'bun:test'
import BrainManager from '../src/brain_manager.ts'
import { brain, AgentRunner, Thread } from '../src/helpers.ts'
import { Agent } from '../src/agent.ts'
import { defineTool } from '../src/tool.ts'
import { z } from 'zod'
import type {
  AIProvider,
  CompletionRequest,
  CompletionResponse,
  StreamChunk,
  ToolCall,
  ToolCallRecord,
  AgentResult,
} from '../src/types.ts'

// ── Mock Provider ────────────────────────────────────────────────────────────

class MockProvider implements AIProvider {
  readonly name = 'mock'
  responses: CompletionResponse[] = []
  requests: CompletionRequest[] = []
  private callIndex = 0

  queueResponse(response: Partial<CompletionResponse>): void {
    this.responses.push({
      id: `mock-${this.responses.length}`,
      content: '',
      toolCalls: [],
      stopReason: 'end',
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
      raw: {},
      ...response,
    })
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    this.requests.push(request)
    const response = this.responses[this.callIndex]
    if (!response) throw new Error(`No mock response queued for call ${this.callIndex}`)
    this.callIndex++
    return response
  }

  async *stream(_request: CompletionRequest): AsyncIterable<StreamChunk> {
    yield { type: 'text', text: 'streamed' }
    yield { type: 'done' }
  }
}

// ── Test Agents ──────────────────────────────────────────────────────────────

class SimpleAgent extends Agent {
  provider = 'mock'
  instructions = 'You are a helpful assistant.'
}

class ToolAgent extends Agent {
  provider = 'mock'
  instructions = 'Use tools when needed.'
  tools = [
    defineTool({
      name: 'add',
      description: 'Add two numbers',
      parameters: z.object({ a: z.number(), b: z.number() }),
      execute: async ({ a, b }: { a: number; b: number }) => ({ sum: a + b }),
    }),
  ]
}

class StructuredAgent extends Agent {
  provider = 'mock'
  instructions = 'Extract data.'
  output = z.object({
    name: z.string(),
    age: z.number(),
  })
}

class ContextAgent extends Agent {
  provider = 'mock'
  instructions = 'Help user {{userName}} with order {{orderId}}.'
}

// ── Setup ────────────────────────────────────────────────────────────────────

function setupMock(): MockProvider {
  const mock = new MockProvider()
  BrainManager.reset()
  BrainManager.useProvider(mock)
  // Manually set config to avoid needing DI container
  ;(BrainManager as any)._config = {
    default: 'mock',
    providers: { mock: { driver: 'openai', apiKey: 'k', model: 'mock-model' } },
    maxTokens: 4096,
    temperature: 0.7,
    maxIterations: 10,
  }
  return mock
}

describe('brain.chat()', () => {
  test('sends prompt and returns text', async () => {
    const mock = setupMock()
    mock.queueResponse({ content: 'Hello back!' })

    const result = await brain.chat('Hello')

    expect(result).toBe('Hello back!')
    expect(mock.requests).toHaveLength(1)
    expect(mock.requests[0]!.messages[0]!.content).toBe('Hello')
  })
})

describe('brain.generate()', () => {
  test('returns structured data from Zod schema', async () => {
    const mock = setupMock()
    mock.queueResponse({ content: '{"name":"Alice","age":30}' })

    const result = await brain.generate({
      prompt: 'Extract: Alice is 30',
      schema: z.object({ name: z.string(), age: z.number() }),
    })

    expect(result.data).toEqual({ name: 'Alice', age: 30 })
    expect(result.text).toBe('{"name":"Alice","age":30}')
    expect(result.usage.totalTokens).toBe(15)
  })

  test('returns structured data from raw JSON Schema', async () => {
    const mock = setupMock()
    mock.queueResponse({ content: '{"name":"Bob"}' })

    const result = await brain.generate({
      prompt: 'Extract name',
      schema: { type: 'object', properties: { name: { type: 'string' } } },
    })

    expect(result.data).toEqual({ name: 'Bob' })
  })

  test('handles markdown-wrapped JSON responses', async () => {
    const mock = setupMock()
    mock.queueResponse({ content: '```json\n{"name":"Alice","age":30}\n```' })

    const result = await brain.generate({
      prompt: 'Extract info',
      schema: { type: 'object', properties: { name: { type: 'string' }, age: { type: 'number' } } },
    })

    expect(result.data).toEqual({ name: 'Alice', age: 30 })
  })

  test('handles markdown without json language hint', async () => {
    const mock = setupMock()
    mock.queueResponse({ content: '```\n{"status":"success"}\n```' })

    const result = await brain.generate({
      prompt: 'Get status',
      schema: { type: 'object', properties: { status: { type: 'string' } } },
    })

    expect(result.data).toEqual({ status: 'success' })
  })
})

describe('AgentRunner.run()', () => {
  test('runs simple agent without tools', async () => {
    const mock = setupMock()
    mock.queueResponse({ content: 'I can help you!' })

    const result = await brain.agent(SimpleAgent).input('Help me').run()

    expect(result.text).toBe('I can help you!')
    expect(result.data).toBe('I can help you!')
    expect(result.iterations).toBe(1)
    expect(result.toolCalls).toHaveLength(0)
    expect(mock.requests[0]!.system).toBe('You are a helpful assistant.')
  })

  test('executes tool loop', async () => {
    const mock = setupMock()

    // First response: model calls the add tool
    mock.queueResponse({
      content: '',
      toolCalls: [{ id: 'tc_1', name: 'add', arguments: { a: 2, b: 3 } }],
      stopReason: 'tool_use',
    })

    // Second response: model uses tool result
    mock.queueResponse({
      content: 'The sum is 5.',
      stopReason: 'end',
    })

    const result = await brain.agent(ToolAgent).input('What is 2 + 3?').run()

    expect(result.text).toBe('The sum is 5.')
    expect(result.iterations).toBe(2)
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0]!.name).toBe('add')
    expect(result.toolCalls[0]!.result).toEqual({ sum: 5 })
    expect(result.toolCalls[0]!.duration).toBeGreaterThanOrEqual(0)

    // Verify the second request includes tool result
    expect(mock.requests[1]!.messages).toHaveLength(3) // user + assistant + tool
    expect(mock.requests[1]!.messages[2]!.role).toBe('tool')
    expect(mock.requests[1]!.messages[2]!.toolCallId).toBe('tc_1')
  })

  test('handles tool errors gracefully', async () => {
    const mock = setupMock()
    const errorTool = defineTool({
      name: 'fail',
      description: 'Always fails',
      parameters: z.object({}),
      execute: async () => {
        throw new Error('boom')
      },
    })

    class ErrorAgent extends Agent {
      provider = 'mock'
      instructions = 'test'
      tools = [errorTool]
    }

    mock.queueResponse({
      content: '',
      toolCalls: [{ id: 'tc_1', name: 'fail', arguments: {} }],
      stopReason: 'tool_use',
    })
    mock.queueResponse({
      content: 'Tool failed, sorry.',
      stopReason: 'end',
    })

    const result = await brain.agent(ErrorAgent).input('test').run()

    expect(result.text).toBe('Tool failed, sorry.')
    expect(result.toolCalls[0]!.result).toBe('Error: boom')
  })

  test('handles unknown tool gracefully', async () => {
    const mock = setupMock()

    mock.queueResponse({
      content: '',
      toolCalls: [{ id: 'tc_1', name: 'nonexistent', arguments: {} }],
      stopReason: 'tool_use',
    })
    mock.queueResponse({
      content: 'Tool not found.',
      stopReason: 'end',
    })

    const result = await brain.agent(ToolAgent).input('test').run()

    expect(result.toolCalls[0]!.result).toContain('not found')
  })

  test('respects maxIterations', async () => {
    const mock = setupMock()

    class LimitedAgent extends Agent {
      provider = 'mock'
      instructions = 'test'
      tools = [
        defineTool({
          name: 'loop',
          description: 'loop',
          parameters: z.object({}),
          execute: async () => 'result',
        }),
      ]
      maxIterations = 2
    }

    // Both responses trigger tool use, so we'll hit max iterations
    mock.queueResponse({
      content: '',
      toolCalls: [{ id: 'tc_1', name: 'loop', arguments: {} }],
      stopReason: 'tool_use',
    })
    mock.queueResponse({
      content: '',
      toolCalls: [{ id: 'tc_2', name: 'loop', arguments: {} }],
      stopReason: 'tool_use',
    })

    const result = await brain.agent(LimitedAgent).input('test').run()

    expect(result.iterations).toBe(2)
    expect(result.data).toBeNull()
  })

  test('interpolates context into instructions', async () => {
    const mock = setupMock()
    mock.queueResponse({ content: 'Done.' })

    await brain
      .agent(ContextAgent)
      .input('help')
      .with({ userName: 'Alice', orderId: '12345' })
      .run()

    expect(mock.requests[0]!.system).toBe('Help user Alice with order 12345.')
  })

  test('.using() overrides provider', async () => {
    const mock1 = setupMock()
    const mock2 = new MockProvider()
    ;(mock2 as any).name = 'mock2'
    Object.defineProperty(mock2, 'name', { value: 'mock2' })
    BrainManager.useProvider(mock2)
    ;(BrainManager as any)._config.providers.mock2 = {
      driver: 'openai',
      apiKey: 'k',
      model: 'mock2-model',
    }

    mock1.queueResponse({ content: 'from mock1' })
    mock2.queueResponse({ content: 'from mock2' })

    // This should use mock2
    const result = await brain.agent(SimpleAgent).input('test').using('mock2').run()

    expect(result.text).toBe('from mock2')
    expect(mock2.requests).toHaveLength(1)
    expect(mock1.requests).toHaveLength(0)
  })

  test('parses structured output with Zod schema', async () => {
    const mock = setupMock()
    mock.queueResponse({ content: '{"name":"Alice","age":30}' })

    const result = await brain.agent(StructuredAgent).input('Extract: Alice is 30').run()

    expect(result.data).toEqual({ name: 'Alice', age: 30 })
  })

  test('accumulates usage across iterations', async () => {
    const mock = setupMock()

    mock.queueResponse({
      content: '',
      toolCalls: [{ id: 'tc_1', name: 'add', arguments: { a: 1, b: 2 } }],
      stopReason: 'tool_use',
      usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    })
    mock.queueResponse({
      content: 'Sum is 3.',
      usage: { inputTokens: 200, outputTokens: 30, totalTokens: 230 },
    })

    const result = await brain.agent(ToolAgent).input('1+2').run()

    expect(result.usage.inputTokens).toBe(300)
    expect(result.usage.outputTokens).toBe(80)
    expect(result.usage.totalTokens).toBe(380)
  })

  test('calls lifecycle hooks', async () => {
    const mock = setupMock()
    const calls: string[] = []

    class HookAgent extends Agent {
      provider = 'mock'
      instructions = 'test'
      tools = [
        defineTool({
          name: 'greet',
          description: 'greet',
          parameters: z.object({}),
          execute: async () => 'hi',
        }),
      ]

      async onStart(input: string) {
        calls.push(`start:${input}`)
      }
      async onToolCall(call: ToolCall) {
        calls.push(`toolCall:${call.name}`)
      }
      async onToolResult(record: ToolCallRecord) {
        calls.push(`toolResult:${record.name}`)
      }
      async onComplete(result: AgentResult) {
        calls.push(`complete:${result.text}`)
      }
    }

    mock.queueResponse({
      content: '',
      toolCalls: [{ id: 'tc_1', name: 'greet', arguments: {} }],
      stopReason: 'tool_use',
    })
    mock.queueResponse({ content: 'Done.' })

    await brain.agent(HookAgent).input('test').run()

    expect(calls).toEqual(['start:test', 'toolCall:greet', 'toolResult:greet', 'complete:Done.'])
  })
})

describe('Thread', () => {
  test('multi-turn conversation', async () => {
    const mock = setupMock()
    mock.queueResponse({ content: 'Hello! How can I help?' })
    mock.queueResponse({ content: 'Your name is Alice.' })

    const thread = brain.thread()
    const r1 = await thread.send('My name is Alice')
    const r2 = await thread.send('What is my name?')

    expect(r1).toBe('Hello! How can I help?')
    expect(r2).toBe('Your name is Alice.')

    // Second request should contain full conversation history
    expect(mock.requests[1]!.messages).toHaveLength(3) // user + assistant + user
  })

  test('thread with agent inherits settings', async () => {
    const mock = setupMock()
    mock.queueResponse({ content: 'Agent response.' })

    const thread = brain.thread(SimpleAgent)
    await thread.send('Hello')

    expect(mock.requests[0]!.system).toBe('You are a helpful assistant.')
  })

  test('system() sets system prompt', async () => {
    const mock = setupMock()
    mock.queueResponse({ content: 'ok' })

    const thread = brain.thread()
    thread.system('Be concise.')
    await thread.send('Hello')

    expect(mock.requests[0]!.system).toBe('Be concise.')
  })

  test('serialize() and restore()', async () => {
    const mock = setupMock()
    mock.queueResponse({ content: 'First response' })
    mock.queueResponse({ content: 'Remembered!' })

    const thread1 = brain.thread()
    thread1.system('You remember things.')
    await thread1.send('Remember: X=42')

    const snapshot = thread1.serialize()

    const thread2 = brain.thread().restore(snapshot)
    await thread2.send('What is X?')

    // The restored thread should have the full history
    expect(mock.requests[1]!.messages).toHaveLength(3) // user + assistant + user
    expect(mock.requests[1]!.system).toBe('You remember things.')
  })

  test('clear() resets messages', async () => {
    const mock = setupMock()
    mock.queueResponse({ content: 'first' })
    mock.queueResponse({ content: 'after clear' })

    const thread = brain.thread()
    await thread.send('Hello')
    thread.clear()
    await thread.send('Fresh start')

    // After clear, second request should only have one message
    expect(mock.requests[1]!.messages).toHaveLength(1)
  })

  test('getMessages() returns copy', async () => {
    const mock = setupMock()
    mock.queueResponse({ content: 'reply' })

    const thread = brain.thread()
    await thread.send('Hello')

    const messages = thread.getMessages()
    expect(messages).toHaveLength(2)
    expect(messages[0]!.role).toBe('user')
    expect(messages[1]!.role).toBe('assistant')

    // Modifying returned array shouldn't affect thread
    messages.pop()
    expect(thread.getMessages()).toHaveLength(2)
  })
})
