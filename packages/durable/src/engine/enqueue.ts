import { getConfig } from '../config.ts'

/**
 * Enqueue durable jobs by INSERTing directly into `_strav_jobs` on the caller's
 * transaction handle.
 *
 * This is a deliberate, documented coupling to `@strav/queue`'s table. It is
 * NOT done via `Queue.push` because `Queue.push` runs its INSERT on a separate
 * connection — outside the engine's transaction — which would break the atomic
 * `{ journal write + run-row update + next-job enqueue }` commit that the whole
 * crash-safety story depends on. The clean long-term fix is an upstream
 * `Queue.pushTx(trx, ...)`; until then, the INSERT shape is replicated here.
 */

/** A Bun SQL transaction handle (tagged-template callable). */
type Tx = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>

async function enqueueJob(
  trx: Tx,
  job: string,
  payload: unknown,
  delay: number
): Promise<void> {
  const cfg = getConfig()
  const availableAt = delay > 0 ? new Date(Date.now() + delay) : new Date()
  await trx`
    INSERT INTO "_strav_jobs"
      ("queue", "job", "payload", "max_attempts", "timeout", "available_at")
    VALUES (
      ${cfg.queue},
      ${job},
      ${JSON.stringify(payload)},
      ${cfg.maxAttempts},
      ${cfg.jobTimeout},
      ${availableAt}
    )
  `
}

/** Enqueue a `durable:advance` continuation for a run at a given step index. */
export async function enqueueAdvance(
  trx: Tx,
  runId: number,
  stepIndex: number,
  opts?: { attempt?: number; delay?: number }
): Promise<void> {
  await enqueueJob(
    trx,
    'durable:advance',
    { runId, stepIndex, attempt: opts?.attempt ?? 1 },
    opts?.delay ?? 0
  )
}

/** Enqueue a `durable:compensate` job for a run at a given compensation cursor. */
export async function enqueueCompensate(
  trx: Tx,
  runId: number,
  compensateIndex: number
): Promise<void> {
  await enqueueJob(trx, 'durable:compensate', { runId, compensateIndex }, 0)
}
