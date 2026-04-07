# @strav/brain

AI module for the [Strav](https://www.npmjs.com/package/@strav/core) framework. Provides a unified interface for AI providers with support for agents, threads, tool use, and multi-step workflows.

## Install

```bash
bun add @strav/brain
```

Requires `@strav/core` as a peer dependency.

## Providers

- **Anthropic** (Claude)
- **OpenAI** (GPT, also works with DeepSeek via custom `baseUrl`)

## Usage

```ts
import { brain } from '@strav/brain'

// One-shot chat
const response = await brain.chat('Explain quantum computing')

// Streaming
for await (const chunk of brain.stream('Write a poem')) {
  process.stdout.write(chunk.text)
}

// Structured output with Zod
import { z } from 'zod'
const result = await brain.generate('List 3 colors', {
  schema: z.object({ colors: z.array(z.string()) }),
})

// Embeddings
const vectors = await brain.embed('Hello world')
```

## Tools

Define tools that AI agents can use:

```ts
import { defineTool } from '@strav/brain'
import { z } from 'zod'

const searchTool = defineTool({
  name: 'search',
  description: 'Search the database',
  parameters: z.object({ query: z.string() }),
  execute: async ({ query }, context) => {
    const userId = context?.userId
    return await db.search(query, { userId })
  },
})
```

The `execute` function receives two parameters:
- `args` - The parsed and validated tool arguments
- `context` - Optional context object passed from the agent runner

## Agents

```ts
import { Agent, defineTool } from '@strav/brain'

class ResearchAgent extends Agent {
  provider = 'anthropic'
  model = 'claude-sonnet-4-20250514'
  instructions = 'You are a research assistant.'
  tools = [searchTool, summarizeTool]
}

// Run agent with context
const runner = brain.agent(ResearchAgent)
runner.context({ userId: '123' }) // Pass context to tools
const result = await runner.input('Find info on Bun').run()
```

## Threads

Multi-turn conversations with serialization support:

```ts
const thread = brain.thread({ provider: 'anthropic', model: 'claude-sonnet-4-20250514' })
await thread.send('Hello')
await thread.send('Tell me more')
const saved = thread.serialize() // persist and restore later
```

## Workflows

Orchestrate multi-agent pipelines:

```ts
const workflow = brain.workflow()
  .step('research', ResearchAgent)
  .step('summarize', SummaryAgent)
  .parallel('review', [FactCheckAgent, StyleAgent])

const result = await workflow.run('Analyze this topic')
```

## License

MIT
