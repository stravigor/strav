import { describe, test, expect } from 'bun:test'
import BrainManager from '../src/brain_manager.ts'
import { brain } from '../src/helpers.ts'
import { Agent } from '../src/agent.ts'
import { defineTool } from '../src/tool.ts'
import { z } from 'zod'
import type {
  AIProvider,
  CompletionRequest,
  CompletionResponse,
  StreamChunk,
  ToolCall,
  AgentResult,
  SuspendedRun,
} from '../src/types.ts'

// ── Mock Provider (parity with helpers.test.ts) ──────────────────────────────

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
    yield { type: 'done' }
  }
}

function setupMock(): MockProvider {
  const mock = new MockProvider()
  BrainManager.reset()
  BrainManager.useProvider(mock)
  ;(BrainManager as any)._config = {
    default: 'mock',
    providers: { mock: { driver: 'openai', apiKey: 'k', model: 'mock-model' } },
    maxTokens: 4096,
    temperature: 0.7,
    maxIterations: 10,
  }
  return mock
}

// ── Narrowing helpers ────────────────────────────────────────────────────────

function isSuspended(r: AgentResult | SuspendedRun): r is SuspendedRun {
  return (r as SuspendedRun).status === 'suspended'
}

// ── Tools ────────────────────────────────────────────────────────────────────

const readOnlyTool = defineTool({
  name: 'lookup_order',
  description: 'Look up an order',
  parameters: z.object({ id: z.string() }),
  execute: async ({ id }: { id: string }) => ({ id, total: 42 }),
})

const mutatingTool = defineTool({
  name: 'issue_refund',
  description: 'Issue a refund',
  parameters: z.object({ id: z.string(), amount: z.number() }),
  execute: async ({ id, amount }: { id: string; amount: number }) => ({
    id,
    refunded: amount,
  }),
})

// ── Agents ───────────────────────────────────────────────────────────────────

const MUTATING_TOOL_NAMES = new Set(['issue_refund'])

class GatedAgent extends Agent {
  provider = 'mock'
  instructions = 'You help customers.'
  tools = [readOnlyTool, mutatingTool]

  shouldSuspend(call: ToolCall): boolean {
    return MUTATING_TOOL_NAMES.has(call.name)
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('AgentRunner.run() — suspension', () => {
  test('suspends before a mutating tool and exposes serializable state', async () => {
    const mock = setupMock()

    // Turn 1: model requests the mutating tool
    mock.queueResponse({
      content: '',
      toolCalls: [{ id: 'tc_1', name: 'issue_refund', arguments: { id: 'ord_1', amount: 50 } }],
      stopReason: 'tool_use',
    })

    const result = await brain.agent(GatedAgent).input('refund order ord_1').run()

    expect(isSuspended(result)).toBe(true)
    if (!isSuspended(result)) throw new Error('unreachable')

    expect(result.pendingToolCalls).toHaveLength(1)
    expect(result.pendingToolCalls[0]!.name).toBe('issue_refund')
    expect(result.pendingToolCalls[0]!.id).toBe('tc_1')
    expect(result.state.iterations).toBe(1)
    expect(result.state.messages).toHaveLength(2) // user + assistant

    // The tool was NOT executed — only one request to the provider so far.
    expect(mock.requests).toHaveLength(1)

    // State survives JSON round-trip (simulates a process boundary).
    const serialized = JSON.stringify(result.state)
    const restored = JSON.parse(serialized)
    expect(restored.messages).toHaveLength(2)
    expect(restored.iterations).toBe(1)
  })

  test('lets read-only tools run autonomously before suspending on a mutating one', async () => {
    const mock = setupMock()

    // Turn 1: model requests both tools in one batch, read-only first.
    mock.queueResponse({
      content: '',
      toolCalls: [
        { id: 'tc_1', name: 'lookup_order', arguments: { id: 'ord_1' } },
        { id: 'tc_2', name: 'issue_refund', arguments: { id: 'ord_1', amount: 42 } },
      ],
      stopReason: 'tool_use',
    })

    const result = await brain.agent(GatedAgent).input('refund order ord_1').run()

    if (!isSuspended(result)) throw new Error('expected suspension')

    // The read-only tool ran; the mutating one is the only pending call.
    expect(result.state.allToolCalls).toHaveLength(1)
    expect(result.state.allToolCalls[0]!.name).toBe('lookup_order')
    expect(result.pendingToolCalls).toHaveLength(1)
    expect(result.pendingToolCalls[0]!.name).toBe('issue_refund')

    // Messages include: user, assistant(2 tool_use), tool(lookup_order result).
    expect(result.state.messages).toHaveLength(3)
    expect(result.state.messages[2]!.role).toBe('tool')
    expect(result.state.messages[2]!.toolCallId).toBe('tc_1')
  })

  test('captures the full remainder of a batch when a mid-batch call suspends', async () => {
    const mock = setupMock()

    // Mutating call sits between two read-only calls. The first read-only runs;
    // when the mutating call is reached, everything after (incl. the second read-only)
    // is carried into pendingToolCalls so the tool_use/tool_result contract stays balanced.
    mock.queueResponse({
      content: '',
      toolCalls: [
        { id: 'tc_a', name: 'lookup_order', arguments: { id: 'ord_1' } },
        { id: 'tc_b', name: 'issue_refund', arguments: { id: 'ord_1', amount: 10 } },
        { id: 'tc_c', name: 'lookup_order', arguments: { id: 'ord_2' } },
      ],
      stopReason: 'tool_use',
    })

    const result = await brain.agent(GatedAgent).input('multi').run()

    if (!isSuspended(result)) throw new Error('expected suspension')
    expect(result.pendingToolCalls.map(c => c.id)).toEqual(['tc_b', 'tc_c'])
    expect(result.state.allToolCalls.map(c => c.name)).toEqual(['lookup_order'])
  })
})

describe('AgentRunner.resume()', () => {
  test('resumes after approval and drives the loop to completion', async () => {
    const mock = setupMock()

    // Turn 1: model requests the mutating tool → suspension.
    mock.queueResponse({
      content: '',
      toolCalls: [{ id: 'tc_1', name: 'issue_refund', arguments: { id: 'ord_1', amount: 50 } }],
      stopReason: 'tool_use',
    })

    const suspended = await brain.agent(GatedAgent).input('refund').run()
    if (!isSuspended(suspended)) throw new Error('expected suspension')

    // Simulate a process boundary: the state is stored, later hydrated from JSON.
    const persisted = JSON.parse(JSON.stringify(suspended.state))

    // Turn 2 queued BEFORE resume: after the approved tool result, the model replies.
    mock.queueResponse({
      content: 'Refund of $50 issued on order ord_1.',
      stopReason: 'end',
    })

    const resumed = await brain
      .agent(GatedAgent)
      .input('refund') // input is ignored on resume; state drives the loop
      .resume(persisted, [{ toolCallId: 'tc_1', result: { id: 'ord_1', refunded: 50 } }])

    expect(isSuspended(resumed)).toBe(false)
    if (isSuspended(resumed)) throw new Error('unreachable')

    expect(resumed.text).toBe('Refund of $50 issued on order ord_1.')
    expect(resumed.iterations).toBe(2) // 1 pre-suspend, 1 post-resume
    expect(resumed.toolCalls).toHaveLength(1)
    expect(resumed.toolCalls[0]!.name).toBe('issue_refund')
    expect(resumed.toolCalls[0]!.result).toEqual({ id: 'ord_1', refunded: 50 })

    // Provider saw the tool_result before the final turn.
    const secondRequest = mock.requests[1]!
    const lastMsg = secondRequest.messages[secondRequest.messages.length - 1]!
    expect(lastMsg.role).toBe('tool')
    expect(lastMsg.toolCallId).toBe('tc_1')
  })

  test('rejection is surfaced as a tool error that the model can adapt to', async () => {
    const mock = setupMock()

    mock.queueResponse({
      content: '',
      toolCalls: [{ id: 'tc_1', name: 'issue_refund', arguments: { id: 'ord_1', amount: 50 } }],
      stopReason: 'tool_use',
    })

    const suspended = await brain.agent(GatedAgent).input('refund').run()
    if (!isSuspended(suspended)) throw new Error('expected suspension')

    // Human rejected — resume with a synthetic error.
    mock.queueResponse({
      content: "I couldn't process the refund; please review manually.",
      stopReason: 'end',
    })

    const resumed = await brain
      .agent(GatedAgent)
      .resume(suspended.state, [
        { toolCallId: 'tc_1', result: { error: 'rejected by agent alice' } },
      ])

    if (isSuspended(resumed)) throw new Error('unexpected suspension')
    expect(resumed.text).toContain('review')

    // The tool message content reflects the synthetic error JSON.
    const toolMsg = mock.requests[1]!.messages.find(m => m.role === 'tool')
    expect(toolMsg?.content).toContain('rejected by agent alice')
  })

  test('chained suspensions: resume that hits another mutating tool suspends again', async () => {
    const mock = setupMock()

    // Turn 1 → suspend on refund.
    mock.queueResponse({
      content: '',
      toolCalls: [{ id: 'tc_1', name: 'issue_refund', arguments: { id: 'ord_1', amount: 50 } }],
      stopReason: 'tool_use',
    })

    const first = await brain.agent(GatedAgent).input('do stuff').run()
    if (!isSuspended(first)) throw new Error('expected first suspension')

    // Turn 2 (after resume) → model asks for ANOTHER mutating call → suspend again.
    mock.queueResponse({
      content: '',
      toolCalls: [{ id: 'tc_2', name: 'issue_refund', arguments: { id: 'ord_2', amount: 25 } }],
      stopReason: 'tool_use',
    })

    const second = await brain
      .agent(GatedAgent)
      .resume(first.state, [{ toolCallId: 'tc_1', result: { id: 'ord_1', refunded: 50 } }])

    expect(isSuspended(second)).toBe(true)
    if (!isSuspended(second)) throw new Error('unreachable')
    expect(second.pendingToolCalls[0]!.id).toBe('tc_2')

    // The prior approved call is preserved in state.allToolCalls across the second suspension.
    const names = second.state.allToolCalls.map(c => c.name)
    expect(names).toEqual(['issue_refund'])
  })
})

describe('no shouldSuspend — existing behavior unchanged', () => {
  test('agents without shouldSuspend run to completion as before', async () => {
    const mock = setupMock()

    class PlainAgent extends Agent {
      provider = 'mock'
      instructions = 'plain'
      tools = [mutatingTool]
    }

    mock.queueResponse({
      content: '',
      toolCalls: [{ id: 'tc_1', name: 'issue_refund', arguments: { id: 'ord_1', amount: 5 } }],
      stopReason: 'tool_use',
    })
    mock.queueResponse({ content: 'done', stopReason: 'end' })

    const result = await brain.agent(PlainAgent).input('go').run()

    if (isSuspended(result)) throw new Error('should not suspend without shouldSuspend hook')
    expect(result.text).toBe('done')
    expect(result.toolCalls).toHaveLength(1)
  })
})
