# @strav/queue

Background job processing and task scheduling for the Strav framework.

## Dependencies
- @strav/kernel (peer)
- @strav/database (peer)

## Consumed by
- @strav/signal (for queued mail/notifications)

## Commands
- bun test
- bun run typecheck

## Architecture
- src/queue/ — Queue manager, worker, job dispatching
- src/scheduler/ — Task scheduler with cron expressions
- src/providers/ — QueueProvider

## Conventions
- Jobs are stored in the database via @strav/database
- Scheduler runs standalone or via CLI (`strav scheduler:work`)

## Payload validation

`Queue.handle(name, handler, { schema })` lets you attach a Zod- (or any `parse(input)`-shaped) validator to a handler. The worker calls `schema.parse(payload)` BEFORE invoking the handler — a parse failure routes the job to `_strav_failed_jobs` with the validation error message. Recommended whenever the payload comes from an external source (HTTP webhook, customer upload) or has churned since older jobs were enqueued.

```ts
import { z } from 'zod'
Queue.handle('send-email', async (payload) => { /* … */ }, {
  schema: z.object({ to: z.string().email(), subject: z.string() }),
})
```

## Per-handler circuit breaker

`Queue.handle(name, handler, { circuitBreaker })` opts a handler into automatic dispatch pausing when its failure rate spikes. Defaults: trip on 10 failures within 60 s, cool down for 30 s, then resume. Defends against retry storms (downed dependency, stale schema) — without it, every fresh job of the failing type just eats another worker cycle.

```ts
Queue.handle('charge-card', chargeHandler, {
  circuitBreaker: { threshold: 5, windowMs: 30_000, cooldownMs: 60_000 },
})
```

When the circuit trips, the worker pushes the in-flight job back to the queue with `available_at = now + cooldownMs`, rolls back the `attempts` counter (the handler never ran), and emits `queue:circuit_tripped`. Cool-down expiry emits `queue:circuit_reset`. Wire either to `@strav/audit` for an operational trail.
