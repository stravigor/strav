# AI

Multi-provider AI with agents, tool use, structured output, multi-turn threads, and workflow orchestration. Supports Anthropic, OpenAI, Google Gemini, and DeepSeek out of the box. Zero SDK dependencies — all provider communication uses raw `fetch()`.

## Quick start

```typescript
import { brain } from '@strav/brain'

// One-shot chat
const answer = await brain.chat('What is the capital of France?')

// Structured output
const { data } = await brain.generate({
  prompt: 'Extract: "Alice is 30 years old"',
  schema: z.object({ name: z.string(), age: z.number() }),
})
// data.name === 'Alice', data.age === 30

// Streaming
for await (const chunk of brain.stream('Write a haiku about code')) {
  if (chunk.type === 'text') process.stdout.write(chunk.text!)
}
```

## Setup

### Using a service provider (recommended)

```typescript
import { BrainProvider } from '@strav/brain'

app.use(new BrainProvider())
```

The `BrainProvider` registers `BrainManager` as a singleton. It depends on the `config` provider.

### Manual setup

```typescript
import BrainManager from '@strav/brain/brain_manager'

app.singleton(BrainManager)
app.resolve(BrainManager)
```

Create `config/ai.ts`:

```typescript
import { env } from '@strav/kernel'

export default {
  default: env('AI_PROVIDER', 'anthropic'),

  providers: {
    anthropic: {
      driver: 'anthropic',
      apiKey: env('ANTHROPIC_API_KEY', ''),
      model: env('ANTHROPIC_MODEL', 'claude-sonnet-4-5-20250929'),
    },
    openai: {
      driver: 'openai',
      apiKey: env('OPENAI_API_KEY', ''),
      model: env('OPENAI_MODEL', 'gpt-4o'),
    },
    google: {
      driver: 'google',
      apiKey: env('GOOGLE_AI_API_KEY', ''),
      model: env('GOOGLE_MODEL', 'gemini-2.0-flash'),
    },
    deepseek: {
      driver: 'openai',
      apiKey: env('DEEPSEEK_API_KEY', ''),
      model: env('DEEPSEEK_MODEL', 'deepseek-chat'),
      baseUrl: 'https://api.deepseek.com',
    },
  },

  maxTokens: env.int('AI_MAX_TOKENS', 4096),
  temperature: env.float('AI_TEMPERATURE', 0.7),
  maxIterations: env.int('AI_MAX_ITERATIONS', 10),
}
```

DeepSeek uses the OpenAI-compatible API — set `driver: 'openai'` with a custom `baseUrl`. Google uses the native Gemini API — set `driver: 'google'`.

## brain helper

The `brain` object is the primary API. All methods respect provider configuration and support per-call overrides.

```typescript
import { brain } from '@strav/brain'
```

### chat

One-shot completion, returns a string:

```typescript
const answer = await brain.chat('Summarize this article: ...')

// With options
const answer = await brain.chat('Translate to French: Hello', {
  provider: 'google',
  model: 'gemini-2.0-flash',
  temperature: 0.3,
  system: 'You are a professional translator.',
})
```

### generate

Structured output with Zod or raw JSON Schema:

```typescript
import { z } from 'zod'

const { data, text, usage } = await brain.generate({
  prompt: 'Extract entities: "John works at Acme Corp in Paris"',
  schema: z.object({
    name: z.string(),
    company: z.string(),
    city: z.string(),
  }),
})
// data.name === 'John', data.company === 'Acme Corp', data.city === 'Paris'

// Raw JSON Schema also works
const { data } = await brain.generate({
  prompt: 'Classify sentiment: "I love this product"',
  schema: {
    type: 'object',
    properties: {
      sentiment: { type: 'string', enum: ['positive', 'negative', 'neutral'] },
      confidence: { type: 'number' },
    },
    required: ['sentiment', 'confidence'],
  },
})
```

### stream

Streaming completion, returns an async iterable:

```typescript
for await (const chunk of brain.stream('Write a poem about TypeScript')) {
  if (chunk.type === 'text') process.stdout.write(chunk.text!)
}
```

### embed

Generate embeddings (OpenAI and Google providers):

```typescript
const vectors = await brain.embed('Hello world', { provider: 'openai' })
// vectors: number[][] — one embedding per input

const batch = await brain.embed(['Hello', 'World'], { provider: 'openai' })

// Google Gemini embeddings
const geminiVectors = await brain.embed('Hello world', { provider: 'google' })
```

## Agents

Agents encapsulate instructions, tools, output format, and lifecycle hooks into reusable classes. They are the building blocks for complex AI interactions.

### Defining an agent

```typescript
import { Agent } from '@strav/brain'
import { defineTool } from '@strav/brain'
import { z } from 'zod'

class SupportAgent extends Agent {
  provider = 'anthropic'
  model = 'claude-sonnet-4-5-20250929'
  instructions = 'You are a customer support agent for {{companyName}}. Help the user with their issue.'

  tools = [
    defineTool({
      name: 'lookup_order',
      description: 'Look up an order by ID',
      parameters: z.object({ orderId: z.string() }),
      execute: async ({ orderId }) => {
        const order = await Order.find(orderId)
        return { status: order.status, items: order.items }
      },
    }),
  ]

  output = z.object({
    reply: z.string(),
    category: z.enum(['billing', 'shipping', 'product', 'other']),
  })
}
```

### Agent properties

| Property | Description | Default |
|---|---|---|
| `provider` | Provider name (`'anthropic'`, `'openai'`, `'google'`, etc.) | Config default |
| `model` | Model identifier | Provider default |
| `instructions` | System prompt. Supports `{{key}}` interpolation — see [Prompt-injection threat model](#prompt-injection-threat-model) | `''` |
| `tools` | Array of `ToolDefinition` objects | `undefined` |
| `output` | Zod schema or JSON Schema for structured output | `undefined` |
| `maxIterations` | Max tool-use loop iterations | Config default (10) |
| `maxTokens` | Max tokens per request | Config default (4096) |
| `temperature` | Temperature | Config default (0.7) |

### Running an agent

Use the fluent `AgentRunner` via `brain.agent()`:

```typescript
const result = await brain.agent(SupportAgent)
  .input('Where is my order #12345?')
  .with({ companyName: 'Acme Corp' })     // trusted context for {{key}} interpolation — see Prompt-injection threat model
  .run()

result.text       // raw response text
result.data       // parsed structured output (if agent has `output` schema)
result.toolCalls  // array of tool calls with results and durations
result.usage      // { inputTokens, outputTokens, totalTokens }
result.iterations // number of completion rounds (1 if no tool use)
```

The runner handles the tool-use loop automatically: when the model calls a tool, the runner executes it, feeds the result back, and re-requests until the model stops or hits `maxIterations`.

`run()` returns `AgentResult | SuspendedRun`. It returns a `SuspendedRun` only when the agent defines the `shouldSuspend` hook and decides to halt before a tool call — see [Pause and resume](#pause-and-resume). Agents without `shouldSuspend` always return `AgentResult`.

### Provider override

Override the provider for a specific run without changing the agent class:

```typescript
const result = await brain.agent(SupportAgent)
  .input('Help me')
  .using('openai', 'gpt-4o')
  .run()
```

### Streaming agents

```typescript
for await (const event of brain.agent(SupportAgent).input('Help me').stream()) {
  switch (event.type) {
    case 'text':
      process.stdout.write(event.text!)
      break
    case 'tool_result':
      console.log('Tool:', event.toolCall!.name, '→', event.toolCall!.result)
      break
    case 'done':
      console.log('Final result:', event.result!.data)
      break
    case 'suspended':
      // Agent paused before a tool call (see "Pause and resume"); no 'done'
      // event is emitted. event.suspended contains pendingToolCalls + state.
      break
  }
}
```

### Lifecycle hooks

Override methods on the agent class to hook into the execution lifecycle:

```typescript
class LoggingAgent extends Agent {
  instructions = 'You are a helpful assistant.'

  async onStart(input: string, context: Record<string, unknown>) {
    console.log('Agent started with:', input)
  }

  async onToolCall(call: ToolCall) {
    console.log(`Calling tool: ${call.name}`)
  }

  async onToolResult(record: ToolCallRecord) {
    console.log(`Tool ${record.name} took ${record.duration}ms`)
  }

  async onComplete(result: AgentResult) {
    console.log('Agent completed:', result.text)
  }

  async onError(error: Error) {
    console.error('Agent failed:', error.message)
  }
}
```

### Pause and resume

An agent can halt its tool-use loop before a tool executes, hand a JSON-serializable snapshot of the loop to the caller, and later resume from that snapshot once an out-of-band result is available. This is a policy-free primitive — the framework does not care *why* you suspend. Common use cases:

- **Human-in-the-loop approval** for mutating tools (e.g., `issue_refund`, `delete_user`): pause the loop, show a UI card, resume after click.
- **Long-running or external tools**: dispatch the tool to a worker, cache, or separate service; resume when the result is ready.
- **Cross-process handoff**: persist the snapshot to a queue, let a different process pick it up.

#### Opting in: `shouldSuspend`

Implement `shouldSuspend` on the agent. Return `true` to halt before the runner executes `call`:

```typescript
class SupportAgent extends Agent {
  instructions = 'You help customers.'
  tools = [lookupOrderTool, issueRefundTool]

  shouldSuspend(call: ToolCall): boolean {
    // Policy lives in your code. The framework just asks yes/no.
    return MUTATING_TOOLS.has(call.name)
  }
}
```

Without this hook, nothing changes — the agent runs to completion as before.

#### The suspended result

When `shouldSuspend` returns `true`, `run()` resolves with a `SuspendedRun` instead of an `AgentResult`:

```typescript
import type { AgentResult, SuspendedRun } from '@strav/brain'

function isSuspended(r: AgentResult | SuspendedRun): r is SuspendedRun {
  return (r as SuspendedRun).status === 'suspended'
}

const result = await brain.agent(SupportAgent).input('refund order 123').run()

if (isSuspended(result)) {
  result.pendingToolCalls  // ToolCall[] — the calls awaiting an external result
  result.state             // SerializedAgentState — JSON-serializable snapshot
}
```

`SerializedAgentState` carries everything the loop needs to continue: `messages`, `allToolCalls`, `totalUsage`, `iterations`. It is plain data; `JSON.stringify(state)` → store → `JSON.parse` → `resume()` is supported.

#### Resuming

Call `resume(state, toolResults)` with one result per pending call. The matching tool message is appended and the loop continues until it either completes or suspends again.

```typescript
const resumed = await brain.agent(SupportAgent).resume(state, [
  { toolCallId: 'tc_1', result: { id: 'ord_123', refunded: 50 } },
])
```

Rejecting a pending call: supply a synthetic error as the result. The model sees a normal tool failure and adapts its reply (typically: asks the human to handle it).

```typescript
await brain.agent(SupportAgent).resume(state, [
  { toolCallId: 'tc_1', result: { error: 'rejected by agent alice' } },
])
```

Chained suspensions are fine: a resume that hits another suspending tool call returns a new `SuspendedRun` with fresh state. Loop the pattern until you get an `AgentResult`.

#### Batch semantics

When the model requests several tool calls in one turn, the runner iterates them in order. Calls before the first suspending one execute normally; when a suspending call is reached, it and every remaining unprocessed call in that batch are captured together in `pendingToolCalls`. You must supply a result for each — this keeps the provider's `tool_use` ↔ `tool_result` pairing balanced on resume.

For example, if the model calls `[lookup_order, issue_refund, lookup_order]` and only `issue_refund` suspends, `lookup_order` (first one) runs and its result is in `state.messages`; `pendingToolCalls` contains `[issue_refund, lookup_order (second)]`. Resume with two results.

#### Cross-process pattern

```typescript
// Process A: drive the agent, persist on suspension
const result = await brain.agent(SupportAgent).input(userMessage).run()
if (isSuspended(result)) {
  await db.pendingToolCall.create({
    ticketId,
    pendingToolCalls: result.pendingToolCalls,
    state: result.state,             // jsonb column
    expiresAt: addDays(new Date(), 7),
  })
  // Render UI asking for approval; worker exits cleanly.
}

// Process B: after human approval, resume
const row = await db.pendingToolCall.findById(pendingId)
const results = row.pendingToolCalls.map(call => ({
  toolCallId: call.id,
  result: await executeApprovedTool(call),
}))
const resumed = await brain.agent(SupportAgent).resume(row.state, results)
// If still suspended, persist again; otherwise, done.
```

#### Streaming

`stream()` emits a `{ type: 'suspended', suspended: SuspendedRun }` event instead of `done` when the agent halts. To continue, call `resume()` on a fresh runner (streaming resume is not currently provided; resume runs non-streaming).

#### Not supported by workflows

`Workflow` steps orchestrate agents end-to-end and have no resume path. A workflow step whose agent suspends throws a clear error. Use `AgentRunner.run()` / `resume()` directly for pause-and-resume flows.

### Prompt-injection threat model

`agent.instructions` supports `{{key}}` placeholders that are filled in from `runner.with({ ... })` context. The substitution drops string values directly into the **system role** of the request sent to the LLM provider — anything user-controlled flowing through this channel is a prompt-injection vector. The model has no way to tell the difference between developer-authored instructions and runtime-substituted user input.

**Rules for callers:**

- **Never** put untrusted user input into agent context. The right place for runtime user input is `runner.input(userMessage)` — that lands in the `user` role, where the model expects untrusted content.
- Use context for **trusted** values only: `userId`, `tenantId`, application configuration your code controls.
- If you must mix untrusted text into a prompt, send it as an extra `user`-role message in a thread, not as a system-prompt placeholder.

```typescript
// CORRECT: untrusted user message goes through .input()
await brain.agent(SupportAgent)
  .input(userQuestion)               // ← untrusted; lands in user role
  .with({ companyName: 'Acme' })     // ← trusted; interpolated into system role
  .run()

// WRONG: untrusted input interpolated into the system prompt
await brain.agent(SupportAgent)
  .with({ companyName: 'Acme', userNote: userInput })  // ✗ injection vector
  .run()
```

**Defense-in-depth in the framework:**

`interpolateInstructions()` runs every context value through `looksLikePromptInjection()` and emits a `console.warn` when a value contains markers commonly used to override system instructions — `"ignore previous instructions"`, `"system:"`, `<|im_start|>`, `[INST]`, role-switch phrases, etc. The warning is informational and the substitution still happens; treat it as a CI/development hint that something untrusted is reaching the system role. The detector is intentionally loose — false positives are cheap, missed exploits are not.

A future release will replace `{{key}}` system-role interpolation with a structured-context API so untrusted values can be passed without ever touching the system role.

## Tools

Tools give agents the ability to call functions. Define them with `defineTool()`:

```typescript
import { defineTool, defineToolbox } from '@strav/brain'

const searchTool = defineTool({
  name: 'search',
  description: 'Search the knowledge base',
  parameters: z.object({
    query: z.string().describe('Search query'),
    limit: z.number().optional(),
  }),
  execute: async ({ query, limit }) => {
    return await KnowledgeBase.search(query, limit ?? 10)
  },
})
```

Parameters accept either a Zod schema (automatically converted to JSON Schema) or a raw JSON Schema object.

### Toolboxes

Group related tools for organization:

```typescript
const dbTools = defineToolbox('database', [
  searchTool,
  insertTool,
  updateTool,
])

class MyAgent extends Agent {
  tools = [...dbTools, weatherTool]
}
```

### Error handling

Tool errors are caught automatically and fed back to the model as error strings. The model can then decide how to proceed:

```typescript
const riskyTool = defineTool({
  name: 'external_api',
  description: 'Call an external API',
  parameters: z.object({ url: z.string() }),
  execute: async ({ url }) => {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`API returned ${res.status}`)
    return await res.json()
  },
})
// If fetch fails, the model receives: "Error: API returned 500"
```

## Threads

Threads manage multi-turn conversations with automatic history tracking:

```typescript
const thread = brain.thread()
thread.system('You are a helpful math tutor.')

const r1 = await thread.send('What is 2 + 2?')    // "4"
const r2 = await thread.send('Multiply that by 3') // "12" — remembers context
```

### Thread with agent

Inherit provider, model, system prompt, and tools from an agent:

```typescript
const thread = brain.thread(SupportAgent)
const reply = await thread.send('I need help with my order')
```

### Basic persistence

Serialize a thread for storage (database, session, cache) and restore later:

```typescript
// Save
const snapshot = thread.serialize()
await cache.set(`thread:${userId}`, snapshot, 3600)

// Restore
const saved = await cache.get<SerializedThread>(`thread:${userId}`)
const thread = brain.thread().restore(saved)
const reply = await thread.send('Continue our conversation')
```

### Streaming threads

`thread.stream()` works like `thread.send()` but yields chunks as they arrive. Tool calls are handled automatically in a loop, just like `send()`:

```typescript
for await (const chunk of thread.stream('What tools do you have?')) {
  if (chunk.type === 'text') process.stdout.write(chunk.text!)
}
// Messages (user, assistant, tool results) are appended to the thread history automatically.
```

### Thread API

```typescript
thread.system('prompt')           // set/override system prompt
thread.using('openai', 'gpt-4o') // override provider
thread.tools([searchTool])        // set available tools
thread.memory()                   // enable memory management (see below)
thread.memory({ strategy: 'summarize', maxContextTokens: 180000 })
thread.id('thread-123')           // set thread ID for persistence
thread.persist()                  // enable auto-persistence to ThreadStore
thread.send('message')            // send and get response (handles tool calls)
thread.stream('message')          // stream response (handles tool calls)
thread.getMessages()              // get copy of message history
thread.facts                      // access semantic memory (if memory enabled)
thread.episodicSummary            // current conversation summary (if memory enabled)
thread.serializeMemory()          // serialize with memory state
thread.restoreMemory(data)        // restore with memory state
thread.clear()                    // reset conversation
```

## Memory management

Long-running conversations will eventually exceed the model's context window. The memory system solves this with a three-tier architecture:

- **Working memory** — recent messages that fit within the context budget
- **Episodic memory** — LLM-generated summaries of compacted older messages
- **Semantic memory** — structured facts extracted from conversation

Memory is **opt-in** — without calling `.memory()`, threads behave exactly as before.

### Enabling memory

```typescript
const thread = brain.thread(OrchestratorAgent)
  .memory()  // enable with defaults from config

// Or with per-thread overrides
const thread = brain.thread()
  .system('You are an entrepreneurship advisor.')
  .memory({
    maxContextTokens: 180000,  // budget (default: auto-detect from model)
    strategy: 'summarize',     // 'summarize' or 'sliding_window'
    responseReserve: 0.20,     // fraction reserved for model response
    minWorkingMessages: 4,     // never compact below this many messages
    compactionBatchSize: 10,   // oldest messages to compact per cycle
    extractFacts: true,        // extract structured facts during compaction
  })
```

When memory is enabled, `thread.send()` and `thread.stream()` automatically:

1. Check if the current messages fit within the token budget
2. If over budget, compact the oldest messages using the configured strategy
3. Inject the episodic summary and semantic facts into the system prompt
4. Send only the trimmed working messages to the model

### Compaction strategies

**Summarize** (default) — Uses the thread's own LLM to generate a natural-language summary of compacted messages. When an existing summary is present, it merges rather than creating a chain of summaries. Optionally extracts structured facts.

**Sliding window** — Drops oldest messages without summarization. No LLM call required. Use when you want fast, predictable compaction and don't need continuity from older messages.

```typescript
// Use sliding window for speed
thread.memory({ strategy: 'sliding_window' })
```

### Semantic memory (facts)

Facts are key-value pairs representing stable knowledge about the user and their situation. They are injected into the system prompt as a `<known_facts>` block so the model always has access to critical context regardless of compaction.

```typescript
const thread = brain.thread().memory()

// Set facts explicitly
thread.facts!.set('venture_type', 'SaaS logistics platform')
thread.facts!.set('current_stage', 'Validation')

// Facts are also extracted automatically during compaction (when extractFacts: true)

// Read facts
thread.facts!.get('venture_type')  // { key, value, source, confidence, createdAt, updatedAt }
thread.facts!.all()                // all facts as array
thread.facts!.remove('old_fact')   // remove a fact
```

The model sees:

```
<known_facts>
- venture_type: SaaS logistics platform
- current_stage: Validation
</known_facts>
```

### Thread persistence

For long-running conversations that span multiple sessions, use the `ThreadStore` interface with `serializeMemory()` / `restoreMemory()`:

```typescript
import { InMemoryThreadStore } from '@strav/brain'
import BrainManager from '@strav/brain'

// Register a thread store (use InMemoryThreadStore for dev, DatabaseThreadStore for production)
BrainManager.useThreadStore(new InMemoryThreadStore())

// Create a persistent thread
const thread = brain.thread(OrchestratorAgent)
  .id('user-123-thread')
  .memory({ strategy: 'summarize', extractFacts: true })
  .persist()  // auto-save after each send()

await thread.send('I have an idea for a logistics SaaS')
// Thread is automatically saved to the store

// On next session — restore
const saved = await BrainManager.threadStore!.load('user-123-thread')
if (saved) {
  const thread = brain.thread(OrchestratorAgent)
    .memory()
    .restoreMemory(saved)

  await thread.send('What were we discussing?')
  // Model has access to summary + facts from previous sessions
}
```

`serializeMemory()` captures messages, system prompt, episodic summary, and semantic facts. `restoreMemory()` restores all of it.

### Custom thread store

Implement the `ThreadStore` interface for database-backed persistence:

```typescript
import type { ThreadStore, SerializedMemoryThread } from '@strav/brain'

class DatabaseThreadStore implements ThreadStore {
  async save(thread: SerializedMemoryThread): Promise<void> {
    await db.query(`
      INSERT INTO threads (id, data, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (id) DO UPDATE SET data = $2, updated_at = NOW()
    `, [thread.id, JSON.stringify(thread)])
  }

  async load(id: string): Promise<SerializedMemoryThread | null> {
    const row = await db.query('SELECT data FROM threads WHERE id = $1', [id])
    return row ? JSON.parse(row.data) : null
  }

  async delete(id: string): Promise<void> {
    await db.query('DELETE FROM threads WHERE id = $1', [id])
  }

  async list(options?: { limit?: number; offset?: number }): Promise<SerializedMemoryThread[]> {
    const rows = await db.query(
      'SELECT data FROM threads ORDER BY updated_at DESC LIMIT $1 OFFSET $2',
      [options?.limit ?? 50, options?.offset ?? 0]
    )
    return rows.map((r: any) => JSON.parse(r.data))
  }
}

BrainManager.useThreadStore(new DatabaseThreadStore())
```

### Custom compaction strategy

Implement the `CompactionStrategy` interface:

```typescript
import type { CompactionStrategy } from '@strav/brain'

const customStrategy: CompactionStrategy = {
  name: 'custom',
  async compact(messages, options) {
    // Your custom logic here
    return {
      summary: 'Custom summary of the conversation...',
      facts: [{ key: 'topic', value: 'logistics', source: 'extracted', confidence: 0.9, createdAt: '', updatedAt: '' }],
      summaryTokens: 10,
    }
  },
}
```

### Memory configuration

Add to `config/ai.ts`:

```typescript
export default {
  default: 'anthropic',
  providers: { /* ... */ },
  maxTokens: 4096,
  temperature: 0.7,
  maxIterations: 10,

  memory: {
    maxContextTokens: 180000,   // leave headroom from 200k window
    strategy: 'summarize',      // 'summarize' | 'sliding_window'
    responseReserve: 0.20,      // 20% reserved for model response
    minWorkingMessages: 4,      // always keep at least 4 recent messages
    compactionBatchSize: 10,    // compact 10 oldest messages per cycle
    extractFacts: true,         // extract structured facts during compaction
  },
}
```

### Token counting

The `TokenCounter` utility provides approximate token estimation (~4 chars/token) without external dependencies:

```typescript
import { TokenCounter } from '@strav/brain'

TokenCounter.estimate('Hello, world!')                      // ~4 tokens
TokenCounter.estimateMessages(thread.getMessages())          // total for message array
TokenCounter.contextWindow('claude-sonnet-4-20250514')       // 200000
```

## Workflows

Workflows orchestrate multiple agents in sequence, parallel, routing, or loop patterns:

```typescript
const result = await brain.workflow('content-pipeline')
  .step('research', ResearchAgent)
  .step('write', WriterAgent, (ctx) => ({
    prompt: `Write about: ${ctx.results.research.text}`,
  }))
  .step('review', ReviewerAgent)
  .run({ topic: 'AI in healthcare' })

result.results.research.text  // research output
result.results.write.text     // written article
result.results.review.text    // review feedback
result.usage                  // aggregated token usage
result.duration               // total wall-clock time (ms)
```

### Sequential steps

Steps run in order. Each step receives the full workflow context (input + all previous results). Use `mapInput` to transform context into the agent's input:

```typescript
brain.workflow('pipeline')
  .step('analyze', AnalyzerAgent)
  .step('summarize', SummaryAgent, (ctx) => ({
    text: ctx.results.analyze.text,
  }))
  .run({ document: '...' })
```

### Parallel steps

Run multiple agents concurrently:

```typescript
brain.workflow('analysis')
  .parallel('analyze', [
    { name: 'sentiment', agent: SentimentAgent },
    { name: 'summary', agent: SummaryAgent },
    { name: 'keywords', agent: KeywordAgent },
  ])
  .run({ text: 'Some article...' })
```

### Routing

A router agent decides which specialist to dispatch to:

```typescript
class TriageAgent extends Agent {
  instructions = 'Classify the support request. Return the category.'
  output = z.object({ route: z.string() })
}

brain.workflow('support')
  .route('triage', TriageAgent, {
    billing: BillingAgent,
    shipping: ShippingAgent,
    technical: TechnicalAgent,
  })
  .run({ message: 'I need a refund' })
```

The router's output must contain a `route` field matching one of the branch keys.

### Loops

Iterate an agent until a condition is met:

```typescript
brain.workflow('refinement')
  .loop('improve', WriterAgent, {
    maxIterations: 5,
    until: (result) => {
      const score = JSON.parse(result.text).quality
      return score >= 8
    },
    feedback: (result) => `Previous attempt scored ${JSON.parse(result.text).quality}/10. Improve.`,
  })
  .run({ task: 'Write a product description' })
```

## Hooks

Register global before/after hooks on `BrainManager` for logging, cost tracking, or rate limiting:

```typescript
import BrainManager from '@strav/brain/brain_manager'

// Log all completions
BrainManager.before((request) => {
  console.log(`AI request: ${request.model}, ${request.messages.length} messages`)
})

BrainManager.after((request, response) => {
  console.log(`AI response: ${response.usage.totalTokens} tokens`)
})
```

## Custom provider

Implement the `AIProvider` interface to add any provider:

```typescript
import type { AIProvider, CompletionRequest, CompletionResponse, StreamChunk } from '@strav/brain'
import BrainManager from '@strav/brain/brain_manager'

class OllamaProvider implements AIProvider {
  readonly name = 'ollama'

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const response = await fetch('http://localhost:11434/api/chat', {
      method: 'POST',
      body: JSON.stringify({
        model: request.model,
        messages: request.messages.map(m => ({ role: m.role, content: m.content })),
        stream: false,
      }),
    })

    const data = await response.json() as any
    return {
      id: crypto.randomUUID(),
      content: data.message.content,
      toolCalls: [],
      stopReason: 'end',
      usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      raw: data,
    }
  }

  async *stream(request: CompletionRequest): AsyncIterable<StreamChunk> {
    // streaming implementation...
    yield { type: 'done' }
  }
}

// In bootstrap
BrainManager.useProvider(new OllamaProvider())
```

## Testing

Swap in a mock provider with `BrainManager.useProvider()`:

```typescript
import { test, expect, beforeEach } from 'bun:test'
import BrainManager from '@strav/brain/brain_manager'
import { brain } from '@strav/brain'
import type { AIProvider, CompletionRequest, CompletionResponse, StreamChunk } from '@strav/brain'

class MockProvider implements AIProvider {
  readonly name = 'mock'
  responses: CompletionResponse[] = []
  requests: CompletionRequest[] = []
  private callIndex = 0

  queueResponse(response: Partial<CompletionResponse>) {
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
    return this.responses[this.callIndex++]!
  }

  async *stream(): AsyncIterable<StreamChunk> {
    yield { type: 'done' }
  }
}

let mock: MockProvider

beforeEach(() => {
  mock = new MockProvider()
  BrainManager.reset()
  BrainManager.useProvider(mock)
  ;(BrainManager as any)._config = {
    default: 'mock',
    providers: { mock: { driver: 'openai', apiKey: 'k', model: 'mock-model' } },
    maxTokens: 4096,
    temperature: 0.7,
    maxIterations: 10,
  }
})

test('one-shot chat', async () => {
  mock.queueResponse({ content: 'Hello!' })
  const answer = await brain.chat('Hi')
  expect(answer).toBe('Hello!')
})
```

## Controller example

```typescript
import { brain } from '@strav/brain'
import { Agent } from '@strav/brain'
import { defineTool } from '@strav/brain'
import { z } from 'zod'

class AssistantAgent extends Agent {
  provider = 'anthropic'
  instructions = 'You are a project management assistant for {{orgName}}.'

  tools = [
    defineTool({
      name: 'list_projects',
      description: 'List active projects for the organization',
      parameters: z.object({ orgId: z.string() }),
      execute: async ({ orgId }) => {
        return await Project.where('organization_id', orgId)
          .where('status', 'active')
          .all()
      },
    }),
  ]
}

export default class AiAssistantController {
  async chat(ctx: Context) {
    const [user, org] = ctx.get<User, Organization>('user', 'organization')
    const { message } = await ctx.body<{ message: string }>()

    const result = await brain.agent(AssistantAgent)
      .input(message)
      .with({ orgName: org.name })
      .run()

    return ctx.json({
      reply: result.text,
      usage: result.usage,
    })
  }
}
```
