# Workflow

General-purpose workflow orchestration. Build multi-step processes with sequential, parallel, conditional, and looping steps. Includes saga-style compensation for automatic rollback on failure. Used internally by `@strav/brain` for multi-agent pipelines.

## Installation

```bash
bun add @strav/workflow
```

No service provider or configuration needed — the `Workflow` class is a standalone utility.

## Basic usage

```typescript
import { workflow } from '@strav/workflow'

const result = await workflow('order-process')
  .step('validate', async (ctx) => {
    const order = await Order.findOrFail(ctx.input.orderId)
    return { order, total: order.total }
  })
  .step('charge', async (ctx) => {
    return await stripe.charges.create({
      amount: ctx.results.validate.total,
      currency: 'usd',
    })
  })
  .step('confirm', async (ctx) => {
    return await sendConfirmation(ctx.results.charge.id)
  })
  .run({ orderId: 123 })

result.results.charge   // Stripe charge object
result.results.confirm  // Confirmation result
result.duration         // Total execution time in ms
```

## Context

Every step receives a `WorkflowContext` with two properties:

```typescript
interface WorkflowContext {
  input: Record<string, unknown>    // The original input passed to .run()
  results: Record<string, unknown>  // Accumulated results from completed steps
}
```

Each step's return value is stored in `ctx.results[stepName]`, making it available to all subsequent steps.

## Step types

### Sequential

The most common step type. Steps run in order, one after another.

```typescript
workflow('etl')
  .step('extract', async (ctx) => {
    return await fetchFromAPI(ctx.input.endpoint)
  })
  .step('transform', async (ctx) => {
    return normalize(ctx.results.extract)
  })
  .step('load', async (ctx) => {
    return await insertIntoDatabase(ctx.results.transform)
  })
  .run({ endpoint: '/users' })
```

### Parallel

Run multiple handlers concurrently with `Promise.all()`. Each entry has a `name` and `handler`. Results are stored under each entry's name.

```typescript
workflow('enrich')
  .step('fetch-user', async (ctx) => User.findOrFail(ctx.input.userId))
  .parallel('enrichments', [
    {
      name: 'avatar',
      handler: async (ctx) => fetchAvatar(ctx.results['fetch-user'].email),
    },
    {
      name: 'geo',
      handler: async (ctx) => geolocate(ctx.results['fetch-user'].ip),
    },
    {
      name: 'score',
      handler: async (ctx) => calculateScore(ctx.results['fetch-user'].id),
    },
  ])
  .step('merge', async (ctx) => ({
    ...ctx.results['fetch-user'],
    avatar: ctx.results.avatar,
    location: ctx.results.geo,
    score: ctx.results.score,
  }))
  .run({ userId: 42 })
```

### Route

Conditionally dispatch to one of several branches. The resolver function returns a string key that matches a branch.

```typescript
workflow('support-ticket')
  .step('classify', async (ctx) => {
    return await classifyTicket(ctx.input.message)
  })
  .route(
    'handle',
    (ctx) => ctx.results.classify.category,  // resolver returns 'billing', 'shipping', etc.
    {
      billing: async (ctx) => handleBilling(ctx),
      shipping: async (ctx) => handleShipping(ctx),
      technical: async (ctx) => handleTechnical(ctx),
    }
  )
  .run({ message: 'My payment failed' })
```

If the resolver returns a key that doesn't match any branch, the step completes silently with no result.

The resolver can also be async:

```typescript
.route('handle', async (ctx) => {
  await Bun.sleep(100)
  return 'billing'
}, { ... })
```

### Loop

Repeat a handler until a condition is met or a maximum iteration count is reached.

```typescript
workflow('data-quality')
  .loop('refine', async (input, ctx) => {
    const improved = await improveDataQuality(input)
    return { data: improved, score: measureQuality(improved) }
  }, {
    maxIterations: 10,
    until: (result) => result.score >= 0.95,
    feedback: (result) => result.data,
    mapInput: (ctx) => ctx.input.rawData,
  })
  .run({ rawData: '...' })
```

**Options:**

| Option | Type | Description |
|--------|------|-------------|
| `maxIterations` | `number` | Maximum number of iterations (required) |
| `until` | `(result, iteration) => boolean` | Stop condition — checked after each iteration |
| `feedback` | `(result) => unknown` | Transforms the result into the next iteration's input |
| `mapInput` | `(ctx) => unknown` | Derives the initial input from context (defaults to `ctx.input`) |

The loop handler signature differs from regular steps — it receives `(input, ctx)` instead of just `(ctx)`. On the first iteration, `input` comes from `mapInput`. On subsequent iterations, `input` comes from `feedback`.

## Compensation (saga pattern)

For multi-step processes where partial failure needs rollback, define `compensate` functions on steps. When a downstream step fails, compensation runs in **reverse order** for all previously completed steps.

```typescript
workflow('order-saga')
  .step('reserve-inventory', async (ctx) => {
    return await reserveItems(ctx.input.items)
  }, {
    compensate: async (ctx) => {
      await releaseItems(ctx.results['reserve-inventory'])
    },
  })
  .step('charge-payment', async (ctx) => {
    return await chargeCard(ctx.input.paymentMethod, ctx.input.total)
  }, {
    compensate: async (ctx) => {
      await refundCharge(ctx.results['charge-payment'].id)
    },
  })
  .step('schedule-shipping', async (ctx) => {
    return await createShipment(ctx.input.address)
  })
  .run({ items: [...], paymentMethod: 'pm_123', total: 99.99, address: '...' })
```

If `schedule-shipping` fails:
1. `refundCharge` runs (reverse of `charge-payment`)
2. `releaseItems` runs (reverse of `reserve-inventory`)
3. The original error is re-thrown

### Compensation errors

If a compensate function itself throws, the error is collected but does **not** prevent other compensations from running. After all compensations complete, a `CompensationError` is thrown containing both the original error and all compensation errors.

```typescript
import { CompensationError } from '@strav/workflow'

try {
  await workflow('saga').step(...).step(...).run({})
} catch (err) {
  if (err instanceof CompensationError) {
    err.originalError        // The step that failed
    err.compensationErrors   // Array of { step, error }
  }
}
```

### Parallel step compensation

Parallel entries can also define compensators:

```typescript
.parallel('notifications', [
  {
    name: 'email',
    handler: async (ctx) => sendEmail(ctx),
    compensate: async (ctx) => recallEmail(ctx.results.email),
  },
  {
    name: 'sms',
    handler: async (ctx) => sendSMS(ctx),
    // no compensator — sms can't be recalled
  },
])
```

## Integrating with `@strav/brain`

The `@strav/brain` workflow is built on top of this package. Each AI agent step wraps an `AgentRunner` execution inside a generic workflow step handler.

```typescript
// This AI workflow...
import { brain } from '@strav/brain'

await brain.workflow('content-pipeline')
  .step('research', ResearchAgent)
  .step('write', WriterAgent, (ctx) => ({
    topic: ctx.results.research.data.summary,
  }))
  .run({ topic: 'AI' })

// ...is equivalent to this general workflow with agent wrappers:
import { workflow } from '@strav/workflow'

await workflow('content-pipeline')
  .step('research', async (ctx) => {
    return await brain.agent(ResearchAgent).input(JSON.stringify(ctx.input)).run()
  })
  .step('write', async (ctx) => {
    const input = JSON.stringify({ topic: ctx.results.research.data.summary })
    return await brain.agent(WriterAgent).input(input).run()
  })
  .run({ topic: 'AI' })
```

## Integrating with the queue

For long-running workflows, dispatch them as queue jobs:

```typescript
import Queue from '@strav/queue'

// Define the job handler
Queue.handle('run-workflow', async (payload) => {
  await workflow(payload.name)
    .step('process', async (ctx) => processData(ctx.input))
    .run(payload.input)
})

// Dispatch from a route handler
router.post('/process', async (ctx) => {
  const body = await ctx.body()
  await Queue.push('run-workflow', { name: 'data-import', input: body })
  return ctx.json({ status: 'queued' }, 202)
})
```

## Error handling

If any step throws, the workflow stops immediately. No subsequent steps run. The error propagates to the caller (after compensation, if configured).

```typescript
try {
  await workflow('risky')
    .step('a', async () => 'ok')
    .step('b', async () => { throw new Error('failed') })
    .step('c', async () => 'never runs')
    .run({})
} catch (err) {
  // err.message === 'failed'
}
```

## API reference

### `workflow(name)`

Create a new `Workflow` instance.

### `Workflow.step(name, handler, options?)`

Add a sequential step.

- `name` — step identifier, used as key in `ctx.results`
- `handler` — `(ctx: WorkflowContext) => Promise<unknown>`
- `options.compensate` — `(ctx: WorkflowContext) => Promise<void>`

### `Workflow.parallel(name, entries)`

Add a parallel step.

- `entries` — array of `{ name, handler, compensate? }`

### `Workflow.route(name, resolver, branches)`

Add a conditional routing step.

- `resolver` — `(ctx: WorkflowContext) => string | Promise<string>`
- `branches` — `Record<string, StepHandler>`

### `Workflow.loop(name, handler, options)`

Add a looping step.

- `handler` — `(input: unknown, ctx: WorkflowContext) => Promise<unknown>`
- `options` — `{ maxIterations, until?, feedback?, mapInput? }`

### `Workflow.run(input)`

Execute the workflow. Returns `Promise<WorkflowResult>`.

```typescript
interface WorkflowResult {
  results: Record<string, unknown>
  duration: number
}
```
