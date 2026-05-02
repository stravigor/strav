# Queue

The queue module provides persistent, retryable background job processing backed by PostgreSQL, plus a cron-like task scheduler for periodic jobs. Jobs survive restarts and can be processed by multiple concurrent workers.

## Components

- **Queue**: Database-backed job processing with retry logic and worker management
- **Scheduler**: Cron-like periodic task execution for maintenance, reports, and cleanup jobs

## Setup

### Using a service provider (recommended)

```typescript
import { QueueProvider } from '@strav/queue'

app.use(new QueueProvider())
```

The `QueueProvider` registers `Queue` as a singleton and creates the queue tables automatically. It depends on the `database` provider.

Options:

| Option | Default | Description |
|--------|---------|-------------|
| `ensureTables` | `true` | Auto-create the jobs and failed_jobs tables |

### Manual setup

```typescript
import { Queue } from '@strav/queue'

app.singleton(Queue)
app.resolve(Queue)
await Queue.ensureTables()
```

This creates `_stravigor_jobs` and `_stravigor_failed_jobs` if they don't exist.

## Configuration

```typescript
// config/queue.ts
import { env } from '@strav/kernel'

export default {
  default: 'default',                           // default queue name
  maxAttempts: env.int('QUEUE_MAX_ATTEMPTS', 3), // retries before failure
  timeout: env.int('QUEUE_TIMEOUT', 60_000),     // per-job timeout (ms)
  retryBackoff: 'exponential' as const,          // 'exponential' | 'linear'
  sleep: env.int('QUEUE_SLEEP', 1000),           // poll interval (ms)
}
```

## Pushing jobs

```typescript
const id = await Queue.push('send-email', { to: 'user@example.com' })
```

Returns the job ID. The job is available for processing immediately.

### Options

```typescript
await Queue.push('send-email', payload, {
  queue: 'emails',     // target a specific queue (default: config default)
  delay: 60_000,       // delay before the job becomes available (ms)
  attempts: 5,         // max retry attempts (default: config maxAttempts)
  timeout: 120_000,    // per-job timeout (default: config timeout)
})
```

## Handling jobs

Register a handler before starting the worker:

```typescript
Queue.handle('send-email', async (payload, meta) => {
  await mailer.send(payload.to, payload.subject)
})
```

The handler receives:
- `payload` — the data passed to `Queue.push()`.
- `meta` — job metadata: `{ id, queue, job, attempts, maxAttempts, progress }`.

If no handler is registered for a job, it moves directly to the failed jobs table.

### Progress reporting

Long-running jobs can report progress via `meta.progress(value, message?)`. `value` is `0..1`. The reported value is persisted to the job row and a `queue:progress` event fires for live consumers (SSE, WebSocket, dashboards).

```typescript
Queue.handle('import-contacts', async (payload, meta) => {
  const rows = await loadRows(payload.fileUrl)
  for (let i = 0; i < rows.length; i++) {
    await processRow(rows[i])
    if (i % 100 === 0) {
      await meta.progress(i / rows.length, `processed ${i}/${rows.length}`)
    }
  }
  await meta.progress(1, 'done')
})
```

Throttle calls to avoid hammering the database — every N rows or every ~1 s is plenty.

#### Polling for progress

```typescript
const snapshot = await Queue.progressOf(jobId)
// → { id, value, message, attempts } or null once the job has completed
```

The job row is deleted on completion, so `progressOf` returns `null` after success — that's the signal the job is done. (For "what was the final result", use the audit log or persist the result yourself.)

#### Subscribing to live progress

```typescript
import Emitter from '@strav/kernel/events/emitter'

Emitter.on('queue:progress', ({ id, value, message }) => {
  // forward to your SSE channel, WebSocket room, etc.
  sse.to('jobs', { jobId: id }).send({ progress: value, message })
})
```

The event is fire-and-forget — failed listeners do not affect the job. Don't put critical work on this listener.

## Worker

The worker polls the queue, picks up jobs, and runs their handlers.

```typescript
import { Worker } from '@strav/queue'

const worker = new Worker({ queue: 'emails', sleep: 500 })
await worker.start() // blocks until worker.stop() is called
```

### How it works

1. Polls for available jobs using `SELECT ... FOR UPDATE SKIP LOCKED` — safe for multiple concurrent workers.
2. Runs the job handler with a `Promise.race` timeout.
3. On success, deletes the job.
4. On failure, either retries (releases back with backoff) or moves to `_stravigor_failed_jobs`.
5. Periodically releases stale jobs from crashed workers.

### Graceful shutdown

The worker listens for `SIGINT` and `SIGTERM`. When received, it finishes the current job and exits cleanly.

```typescript
worker.stop() // can also be called programmatically
```

### Backoff strategy

When a job fails and has remaining attempts, it's released back to the queue with a delay:

- **Exponential** (default): `2^attempts * 1000ms + random jitter` — e.g., 2s, 4s, 8s, 16s...
- **Linear**: `attempts * 5000ms` — e.g., 5s, 10s, 15s...

## Events bridge

Use `Queue.listener()` to connect the event bus to the queue:

```typescript
import { Emitter } from '@strav/kernel'
import { Queue } from '@strav/queue'

Emitter.on('user.registered', Queue.listener('send-welcome-email'))
Emitter.on('order.placed', Queue.listener('generate-invoice', { queue: 'billing' }))
```

When the event fires, the payload is automatically pushed as a job. This is ideal for offloading slow work from the request cycle.

The [Notification module](./notification.md) also uses the queue — notifications with `shouldQueue()` returning `true` are pushed as `stravigor:send-notification` jobs and delivered by the worker.

## Queue management

### Introspection

```typescript
await Queue.size()              // pending jobs in the default queue
await Queue.size('emails')      // pending jobs in a specific queue
await Queue.pending()           // list pending jobs (default queue, limit 25)
await Queue.pending('emails')   // list pending jobs in a specific queue
```

### Failed jobs

```typescript
await Queue.failed()            // list failed jobs (all queues)
await Queue.failed('emails')    // list failed jobs for a specific queue
await Queue.retryFailed()       // move all failed jobs back to the queue
await Queue.retryFailed('emails')
await Queue.clearFailed()       // delete all failed jobs
await Queue.clearFailed('emails')
```

### Clearing

```typescript
await Queue.clear()             // delete all pending jobs in default queue
await Queue.clear('emails')     // delete all pending jobs in a specific queue
await Queue.flush()             // delete everything (jobs + failed) — dev/test only
```

## CLI commands

### queue:work

Start a worker process:

```bash
bun strav queue:work
bun strav queue:work --queue emails --sleep 500
```

**Options:**
- `--queue <name>` — Queue to process (default: `'default'`).
- `--sleep <ms>` — Poll interval in milliseconds (default: `1000`).

Press Ctrl+C to stop gracefully.

### schedule

Start the task scheduler:

```bash
bun strav schedule
```

Runs periodic tasks defined in `app/schedules.ts`. See [Scheduler documentation](./scheduler.md) for complete details.

### queue:retry

Move failed jobs back to the queue for reprocessing:

```bash
bun strav queue:retry
bun strav queue:retry --queue emails
```

**Options:**
- `--queue <name>` — Only retry failed jobs from this queue.

### queue:flush

Delete jobs from a queue:

```bash
bun strav queue:flush
bun strav queue:flush --queue emails
bun strav queue:flush --failed          # also clear failed jobs
```

**Options:**
- `--queue <name>` — Queue to flush (default: `'default'`).
- `--failed` — Also clear failed jobs.

## Database tables

The queue module creates two internal tables (prefixed with `_stravigor_`):

**_stravigor_jobs**

| Column | Type | Notes |
|--------|------|-------|
| id | BIGSERIAL | Primary key |
| queue | VARCHAR(255) | Default `'default'` |
| job | VARCHAR(255) | Job name |
| payload | JSONB | Serialized data |
| attempts | INT | Current attempt count |
| max_attempts | INT | Max retries |
| timeout | INT | Per-job timeout (ms) |
| available_at | TIMESTAMPTZ | When the job becomes available |
| reserved_at | TIMESTAMPTZ | NULL if available, set when a worker picks it up |
| created_at | TIMESTAMPTZ | |

A partial index on `(queue, available_at) WHERE reserved_at IS NULL` ensures only fetchable jobs are indexed.

**_stravigor_failed_jobs**

| Column | Type | Notes |
|--------|------|-------|
| id | BIGSERIAL | Primary key |
| queue | VARCHAR(255) | |
| job | VARCHAR(255) | |
| payload | JSONB | Original payload |
| error | TEXT | Error message |
| failed_at | TIMESTAMPTZ | |

## Full example

```typescript
import { Emitter } from '@strav/kernel'
import { Queue, Worker, Scheduler } from '@strav/queue'

// Bootstrap
app.singleton(Queue)
app.resolve(Queue)
await Queue.ensureTables()

// Register queue handlers
Queue.handle('send-welcome-email', async (payload, meta) => {
  await mailer.send(payload.email, 'Welcome!')
  console.log(`Sent welcome email (attempt ${meta.attempts}/${meta.maxAttempts})`)
})

Queue.handle('generate-report', async (payload) => {
  const report = await buildReport(payload.userId)
  await saveReport(report)
})

// Register scheduled tasks
Scheduler.task('cleanup:sessions', async () => {
  await db.sql`DELETE FROM "_strav_sessions" WHERE "expires_at" < NOW()`
}).hourly()

Scheduler.task('warm-cache', async () => {
  await warmApplicationCache()
}).daily()
  .runImmediately() // runs immediately on startup, then daily

// Connect events to queue
Emitter.on('user.registered', Queue.listener('send-welcome-email'))

// Push a job directly
await Queue.push('generate-report', { userId: 42 }, {
  queue: 'reports',
  timeout: 120_000,
})

// Manual task execution
await Scheduler.runNow('cleanup:sessions')

// Start a worker (typically in a separate process)
const worker = new Worker()
await worker.start()
```

## Testing

Use `Queue.flush()`, `Queue.reset()`, and `Scheduler.reset()` in your test teardown:

```typescript
import { afterEach } from 'bun:test'
import { Queue, Scheduler } from '@strav/queue'

afterEach(async () => {
  await Queue.flush()  // clear all jobs from DB
  Queue.reset()        // clear registered handlers
  Scheduler.reset()    // clear registered scheduled tasks
})
```
