import { sql, transaction } from '@strav/database'
import { Queue } from '@strav/queue'
import { registry } from './registry.ts'
import { ensureTables } from './schema.ts'
import { configureDurable, type DurableConfig } from './config.ts'
import { RunNotFoundError } from './errors.ts'
import type {
  ResumeResult,
  RunStatus,
  RunStatusSnapshot,
  StartResult,
} from './types.ts'
import { writeJournal } from './models/journal.ts'
import {
  advanceHandler,
  applyPatch,
  compensateHandler,
  enqueueAdvance,
  enqueueCompensate,
  loadRun,
  lockRun,
  type AdvancePayload,
  type CompensatePayload,
  type Tx,
} from './engine/index.ts'

/** Drop engine-internal keys so `results` reads like a `@strav/workflow` context. */
function publicResults(state: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(state)) {
    if (!key.startsWith('__strav_')) out[key] = value
  }
  return out
}

async function cancelRecursive(trx: Tx, runId: number): Promise<void> {
  await trx`
    UPDATE "_strav_workflow_runs"
    SET "status" = 'canceled', "updated_at" = NOW()
    WHERE "id" = ${runId}
      AND "status" IN ('pending', 'running', 'suspended', 'compensating')
  `
  const children = (await trx`
    SELECT "id" FROM "_strav_workflow_runs" WHERE "parent_run_id" = ${runId}
  `) as Record<string, unknown>[]
  for (const child of children) {
    await cancelRecursive(trx, Number(child.id))
  }
}

/**
 * Static facade for the durable execution engine.
 *
 * @example
 * await Durable.start('milestone', { projectId: 42 })
 * const snapshot = await Durable.status(runId)
 * await Durable.resume(runId, 'founder-signoff', { approved: true })
 */
export class Durable {
  /** Create the engine's tables (`_strav_workflow_runs`, `_strav_workflow_journal`). */
  static async ensureTables(): Promise<void> {
    await ensureTables()
  }

  /** Override engine configuration (queue name, job timeout, max attempts). */
  static configure(patch: Partial<DurableConfig>): void {
    configureDurable(patch)
  }

  /**
   * Register the `durable:advance` / `durable:compensate` queue handlers.
   * Called by `DurableProvider.boot`; idempotent.
   */
  static registerHandlers(): void {
    Queue.handle('durable:advance', async (payload: unknown) => {
      await advanceHandler(payload as AdvancePayload)
    })
    Queue.handle('durable:compensate', async (payload: unknown) => {
      await compensateHandler(payload as CompensatePayload)
    })
  }

  /**
   * Start a new durable run. Inserts the run row and enqueues the first
   * step's `durable:advance` job in a single transaction. Returns immediately
   * — the workflow runs on the queue.
   */
  static async start(
    workflowName: string,
    input: Record<string, unknown> = {},
    opts?: { parentRunId?: number; parentStepId?: string }
  ): Promise<StartResult> {
    registry.get(workflowName) // throws if not registered

    return await transaction(async (trx: Tx) => {
      const rows = (await trx`
        INSERT INTO "_strav_workflow_runs"
          ("workflow_name", "input", "status", "state", "current_step",
           "parent_run_id", "parent_step_id")
        VALUES (
          ${workflowName}, ${JSON.stringify(input)}, 'running', '{}', 0,
          ${opts?.parentRunId ?? null}, ${opts?.parentStepId ?? null}
        )
        RETURNING "id"
      `) as Record<string, unknown>[]
      const runId = Number(rows[0]!.id)
      await enqueueAdvance(trx, runId, 0)
      return { runId, status: 'running' as RunStatus }
    })
  }

  /**
   * Deliver a signal to a suspended run.
   *
   * - `waitForSignal` step → journals the payload, advances past the step.
   * - A suspended brain-agent `.step` → stores the payload and re-enters the
   *   step so the handler can call `runner.resume(...)`.
   *
   * Returns `{ accepted: false }` if the run is not suspended on a matching
   * signal (idempotent — a duplicate or mismatched signal is a no-op).
   */
  static async resume(
    runId: number,
    signal: string,
    data?: unknown
  ): Promise<ResumeResult> {
    return await transaction(async (trx: Tx) => {
      const run = await lockRun(trx, runId)
      if (!run) throw new RunNotFoundError(runId)
      if (run.status !== 'suspended' || run.awaitingSignal !== signal) {
        return { accepted: false, status: run.status }
      }

      const step = registry.get(run.workflowName).steps[run.currentStep]
      if (!step) return { accepted: false, status: run.status }

      if (step.type === 'signal') {
        await writeJournal(trx, runId, [
          { stepId: step.name, status: 'completed', result: data ?? null, attempt: 1 },
        ])
        const newState = applyPatch(run.state, { [step.name]: data ?? null })
        const next = run.currentStep + 1
        await trx`
          UPDATE "_strav_workflow_runs"
          SET "status" = 'running', "awaiting_signal" = NULL,
              "state" = ${JSON.stringify(newState)}, "current_step" = ${next},
              "updated_at" = NOW()
          WHERE "id" = ${runId}
        `
        await enqueueAdvance(trx, runId, next)
        return { accepted: true, status: 'running' as RunStatus }
      }

      if (step.type === 'step') {
        // A suspended brain agent — re-enter the same step with the resume data.
        const newState = applyPatch(run.state, { __strav_resume__: data ?? null })
        await trx`
          UPDATE "_strav_workflow_runs"
          SET "status" = 'running', "awaiting_signal" = NULL,
              "state" = ${JSON.stringify(newState)}, "updated_at" = NOW()
          WHERE "id" = ${runId}
        `
        await enqueueAdvance(trx, runId, run.currentStep)
        return { accepted: true, status: 'running' as RunStatus }
      }

      return { accepted: false, status: run.status }
    })
  }

  /** Snapshot a run's live state (and one level of child runs). */
  static async status(runId: number): Promise<RunStatusSnapshot> {
    const run = await loadRun(runId)
    if (!run) throw new RunNotFoundError(runId)

    const totalSteps = registry.has(run.workflowName)
      ? registry.get(run.workflowName).steps.length
      : 0

    const childRows = (await sql`
      SELECT "id" FROM "_strav_workflow_runs"
      WHERE "parent_run_id" = ${runId} ORDER BY "id"
    `) as Record<string, unknown>[]
    const children: RunStatusSnapshot[] = []
    for (const child of childRows) {
      children.push(await Durable.status(Number(child.id)))
    }

    return {
      runId: run.id,
      workflowName: run.workflowName,
      status: run.status,
      currentStep: run.currentStep,
      totalSteps,
      awaitingSignal: run.awaitingSignal,
      wakeAt: run.wakeAt ? run.wakeAt.toISOString() : null,
      results: publicResults(run.state),
      error: run.error,
      parentRunId: run.parentRunId,
      children,
    }
  }

  /** List runs, most recent first, optionally filtered by status / parent. */
  static async list(filter?: {
    status?: RunStatus
    parentRunId?: number
  }): Promise<RunStatusSnapshot[]> {
    const status = filter?.status ?? null
    const parentRunId = filter?.parentRunId ?? null
    const rows = (await sql`
      SELECT "id" FROM "_strav_workflow_runs"
      WHERE (${status}::text IS NULL OR "status" = ${status})
        AND (${parentRunId}::bigint IS NULL OR "parent_run_id" = ${parentRunId})
      ORDER BY "id" DESC
    `) as Record<string, unknown>[]

    const snapshots: RunStatusSnapshot[] = []
    for (const row of rows) {
      snapshots.push(await Durable.status(Number(row.id)))
    }
    return snapshots
  }

  /** Cancel a run and all of its descendant child runs. */
  static async cancel(runId: number): Promise<void> {
    await transaction(async (trx: Tx) => {
      await cancelRecursive(trx, runId)
    })
  }

  /**
   * Re-enqueue runs that are `running` / `compensating` but have no live
   * `_strav_jobs` row — e.g. a job that dead-lettered. Returns the count
   * recovered. Safe to run periodically (e.g. via the `@strav/queue` Scheduler).
   */
  static async recover(): Promise<number> {
    const rows = (await sql`
      SELECT r."id", r."status", r."current_step", r."compensation_cursor"
      FROM "_strav_workflow_runs" r
      WHERE r."status" IN ('running', 'compensating')
        AND NOT EXISTS (
          SELECT 1 FROM "_strav_jobs" j
          WHERE j."job" IN ('durable:advance', 'durable:compensate')
            AND (j."payload"->>'runId')::bigint = r."id"
        )
    `) as Record<string, unknown>[]

    let recovered = 0
    for (const row of rows) {
      const runId = Number(row.id)
      await transaction(async (trx: Tx) => {
        if (row.status === 'running') {
          await enqueueAdvance(trx, runId, Number(row.current_step))
        } else if (row.compensation_cursor != null) {
          await enqueueCompensate(trx, runId, Number(row.compensation_cursor))
        }
      })
      recovered++
    }
    return recovered
  }

  /** Clear the workflow registry. For testing only. */
  static reset(): void {
    registry.reset()
  }
}
