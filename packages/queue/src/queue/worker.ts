import Queue, { hydrateJob } from './queue.ts'
import Emitter from '@strav/kernel/events/emitter'
import { checkBreaker, recordFailure, recordSuccess } from './circuit_breaker.ts'
import type { JobRecord, JobMeta } from './queue.ts'

export interface WorkerOptions {
  queue?: string
  sleep?: number
}

/**
 * Processes jobs from the queue.
 *
 * Uses `SELECT ... FOR UPDATE SKIP LOCKED` for safe concurrent polling.
 * Supports job timeouts, exponential/linear backoff for retries,
 * and graceful shutdown on SIGINT/SIGTERM.
 *
 * @example
 * const worker = new Worker({ queue: 'emails', sleep: 500 })
 * await worker.start() // blocks until worker.stop() is called
 */
export default class Worker {
  private running = false
  private processing = false
  private queue: string
  private sleep: number

  constructor(options: WorkerOptions = {}) {
    this.queue = options.queue ?? Queue.config.default
    this.sleep = options.sleep ?? Queue.config.sleep
  }

  /** Start the worker loop. Blocks until stop() is called. */
  async start(): Promise<void> {
    this.running = true

    const onSignal = () => this.stop()
    process.on('SIGINT', onSignal)
    process.on('SIGTERM', onSignal)

    let pollCount = 0

    try {
      while (this.running) {
        // Periodically release stale jobs (every 60 cycles)
        if (pollCount % 60 === 0) {
          await this.releaseStaleJobs()
        }
        pollCount++

        const job = await this.fetchNext()
        if (job) {
          this.processing = true
          await this.process(job)
          this.processing = false
        } else {
          await Bun.sleep(this.sleep)
        }
      }
    } finally {
      process.off('SIGINT', onSignal)
      process.off('SIGTERM', onSignal)
    }
  }

  /** Signal the worker to stop after the current job completes. */
  stop(): void {
    this.running = false
  }

  /** Whether the worker is currently processing a job. */
  get busy(): boolean {
    return this.processing
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  /**
   * Fetch the next available job using FOR UPDATE SKIP LOCKED.
   * Atomically reserves it by setting reserved_at and incrementing attempts.
   */
  private async fetchNext(): Promise<JobRecord | null> {
    const sql = Queue.db.sql

    const rows = await sql.begin(async (tx: any) => {
      const result = await tx`
        SELECT * FROM "_strav_jobs"
        WHERE "queue" = ${this.queue}
          AND "available_at" <= NOW()
          AND "reserved_at" IS NULL
        ORDER BY "available_at" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `
      if (result.length === 0) return []

      const job = result[0] as Record<string, unknown>
      await tx`
        UPDATE "_strav_jobs"
        SET "reserved_at" = NOW(), "attempts" = "attempts" + 1
        WHERE "id" = ${job.id}
      `
      return [{ ...job, attempts: (job.attempts as number) + 1 }]
    })

    return rows.length > 0 ? hydrateJob(rows[0] as Record<string, unknown>) : null
  }

  /** Process a single job: run handler, handle success/failure. */
  private async process(job: JobRecord): Promise<void> {
    const registration = Queue.handlers.get(job.job)

    if (!registration) {
      await this.fail(job, new Error(`No handler registered for job "${job.job}"`))
      return
    }

    // Q-1: per-handler circuit breaker. If the handler has tripped its
    // breaker (too many failures in the configured window), defer this
    // job rather than running it. Push it back to the queue with
    // `available_at = now + cooldown` so it retries AFTER the breaker
    // resets — this clears the worker to drain unrelated jobs from the
    // queue instead of compounding the failure storm.
    const cooldownRemaining = checkBreaker(job.job)
    if (cooldownRemaining !== null) {
      await this.deferForCooldown(job, cooldownRemaining)
      return
    }

    const meta: JobMeta = {
      id: job.id,
      queue: job.queue,
      job: job.job,
      attempts: job.attempts,
      maxAttempts: job.maxAttempts,
      progress: (value: number, message?: string) => Queue.reportProgress(job.id, value, message),
    }

    // Re-parse the payload through the registered schema (CC-5). Catches
    // payloads that drifted from the handler's expected shape — older
    // enqueues, manual DB edits, malicious tampering. A parse failure
    // is fatal: the job goes straight to failed_jobs without retry,
    // because retrying with the same bad payload won't help.
    let payload = job.payload
    if (registration.schema) {
      try {
        payload = registration.schema.parse(job.payload)
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        await this.fail(job, new Error(`Job "${job.job}" payload failed validation: ${detail}`))
        return
      }
    }

    const start = performance.now()

    try {
      await Promise.race([
        Promise.resolve(registration.handler(payload, meta)),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`Job "${job.job}" timed out after ${job.timeout}ms`)),
            job.timeout
          )
        ),
      ])
      await this.complete(job)
      recordSuccess(job.job)

      if (Emitter.listenerCount('queue:processed') > 0) {
        const duration = performance.now() - start
        Emitter.emit('queue:processed', {
          job: job.job,
          id: job.id,
          queue: job.queue,
          duration,
        }).catch(() => {})
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      // Update breaker state regardless of retry decision so a job that
      // exhausts its retries still counts toward the trip threshold.
      recordFailure(job.job)
      if (job.attempts >= job.maxAttempts) {
        await this.fail(job, err)

        if (Emitter.listenerCount('queue:failed') > 0) {
          const duration = performance.now() - start
          Emitter.emit('queue:failed', {
            job: job.job,
            id: job.id,
            queue: job.queue,
            error: err.message,
            duration,
          }).catch(() => {})
        }
      } else {
        await this.release(job)
      }
    }
  }

  /** Delete a completed job. */
  private async complete(job: JobRecord): Promise<void> {
    await Queue.db.sql`DELETE FROM "_strav_jobs" WHERE "id" = ${job.id}`
  }

  /** Move a job to the failed_jobs table and delete from jobs. */
  private async fail(job: JobRecord, error: Error): Promise<void> {
    const sql = Queue.db.sql
    await sql.begin(async (tx: any) => {
      await tx`
        INSERT INTO "_strav_failed_jobs" ("queue", "job", "payload", "error")
        VALUES (${job.queue}, ${job.job}, ${JSON.stringify(job.payload)}, ${error.message})
      `
      await tx`DELETE FROM "_strav_jobs" WHERE "id" = ${job.id}`
    })
  }

  /** Release a job back to the queue with incremented backoff delay. */
  private async release(job: JobRecord): Promise<void> {
    const delay = this.backoffDelay(job.attempts)
    const availableAt = new Date(Date.now() + delay)

    await Queue.db.sql`
      UPDATE "_strav_jobs"
      SET "reserved_at" = NULL, "available_at" = ${availableAt}
      WHERE "id" = ${job.id}
    `
  }

  /**
   * Push a tripped-circuit job back to the queue with `available_at`
   * scheduled past the cooldown. Also rolls back the attempts counter
   * the fetcher incremented so a circuit trip doesn't eat retry
   * budget — the job genuinely never executed.
   */
  private async deferForCooldown(job: JobRecord, cooldownMs: number): Promise<void> {
    const availableAt = new Date(Date.now() + Math.max(cooldownMs, 1_000))

    await Queue.db.sql`
      UPDATE "_strav_jobs"
      SET "reserved_at" = NULL,
          "available_at" = ${availableAt},
          "attempts" = GREATEST("attempts" - 1, 0)
      WHERE "id" = ${job.id}
    `
  }

  /** Calculate backoff delay in ms based on attempt number. */
  backoffDelay(attempts: number): number {
    if (Queue.config.retryBackoff === 'linear') {
      return attempts * 5_000
    }
    // Exponential: 2^attempts * 1000, with jitter
    const base = Math.pow(2, attempts) * 1000
    const jitter = Math.random() * 1000
    return base + jitter
  }

  /** Release jobs that have been reserved for too long (crashed workers). */
  private async releaseStaleJobs(): Promise<void> {
    await Queue.db.sql`
      UPDATE "_strav_jobs"
      SET "reserved_at" = NULL
      WHERE "reserved_at" IS NOT NULL
        AND "queue" = ${this.queue}
        AND "reserved_at" < NOW() - MAKE_INTERVAL(secs => "timeout" * 2.0 / 1000)
    `
  }
}
