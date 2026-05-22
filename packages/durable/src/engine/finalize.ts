import { transaction } from '@strav/database'
import type { RunRow } from '../types.ts'
import { writeJournal } from '../models/journal.ts'
import { enqueueAdvance, enqueueCompensate } from './enqueue.ts'
import { lockRun, type Tx } from './run_store.ts'

/** Merge a result patch into a run's accumulated state. */
export function applyPatch(
  state: Record<string, unknown>,
  patch: Record<string, unknown>
): Record<string, unknown> {
  return { ...state, ...patch }
}

/**
 * Transition a run into compensation, rolling back from the step before the
 * one that failed. If nothing was completed before it, fail the run directly.
 */
export async function beginCompensation(
  trx: Tx,
  run: RunRow,
  failedStepIndex: number,
  failure: string
): Promise<void> {
  const cursor = failedStepIndex - 1
  if (cursor < 0) {
    await failRun(trx, run, failure)
    return
  }
  await trx`
    UPDATE "_strav_workflow_runs"
    SET "status" = 'compensating', "compensation_cursor" = ${cursor},
        "error" = ${failure}, "updated_at" = NOW()
    WHERE "id" = ${run.id}
  `
  await enqueueCompensate(trx, run.id, cursor)
}

/** Mark a run failed and, if it is a child, propagate failure to its parent. */
export async function failRun(trx: Tx, run: RunRow, failure: string): Promise<void> {
  await trx`
    UPDATE "_strav_workflow_runs"
    SET "status" = 'failed', "error" = ${failure}, "updated_at" = NOW()
    WHERE "id" = ${run.id}
  `
  if (run.parentRunId != null) {
    await finalizeChildIntoParent(trx, run, 'failed')
  }
}

/**
 * Complete a run. Opens its own transaction (called as the terminal advance).
 * If the run is a child, fan in: write its result into the parent journal and
 * resume the parent — all in the same transaction, so the parent's
 * continuation job is visible only once the child result is.
 */
export async function completeRun(runId: number): Promise<void> {
  await transaction(async (trx: Tx) => {
    const run = await lockRun(trx, runId)
    if (!run || run.status !== 'running') return
    await trx`
      UPDATE "_strav_workflow_runs"
      SET "status" = 'completed', "result" = ${JSON.stringify(run.state)},
          "updated_at" = NOW()
      WHERE "id" = ${runId}
    `
    if (run.parentRunId != null) {
      await finalizeChildIntoParent(trx, run, 'completed')
    }
  })
}

/**
 * Fan a finished child run into its parent. Locks the parent (child→parent
 * lock order is consistent everywhere, so no deadlock).
 */
export async function finalizeChildIntoParent(
  trx: Tx,
  childRun: RunRow,
  outcome: 'completed' | 'failed'
): Promise<void> {
  const parentId = childRun.parentRunId
  const childStepId = childRun.parentStepId
  if (parentId == null || childStepId == null) return

  const parent = await lockRun(trx, parentId)
  if (!parent || parent.status !== 'suspended') return

  const parentStepIndex = parent.currentStep

  if (outcome === 'completed') {
    await writeJournal(trx, parentId, [
      { stepId: childStepId, status: 'completed', result: childRun.state, attempt: 1 },
    ])
    const newState = applyPatch(parent.state, { [childStepId]: childRun.state })
    const next = parentStepIndex + 1
    await trx`
      UPDATE "_strav_workflow_runs"
      SET "status" = 'running', "state" = ${JSON.stringify(newState)},
          "current_step" = ${next}, "updated_at" = NOW()
      WHERE "id" = ${parentId}
    `
    await enqueueAdvance(trx, parentId, next)
  } else {
    const failure = `child workflow "${childRun.workflowName}" failed`
    await writeJournal(trx, parentId, [
      { stepId: childStepId, status: 'failed', error: failure, attempt: 1 },
    ])
    await beginCompensation(trx, parent, parentStepIndex, failure)
  }
}
