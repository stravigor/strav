import { transaction } from '@strav/database'
import { registry } from '../registry.ts'
import type { JournalWrite } from '../types.ts'
import { loadJournal, writeJournal } from '../models/journal.ts'
import { buildContext } from './context.ts'
import { enqueueCompensate } from './enqueue.ts'
import { failRun } from './finalize.ts'
import { loadRun, lockRun, type Tx } from './run_store.ts'
import { runCompensator } from './compensation_driver.ts'

/** Payload of a `durable:compensate` job. */
export interface CompensatePayload {
  runId: number
  compensateIndex: number
}

/**
 * The `durable:compensate` queue handler — rolls back one step of a failed
 * run. The chain walks `compensation_cursor` downward; each step's compensation
 * is journaled (`<step>#compensate`), so rollback resumes crash-safely. When
 * the cursor reaches below zero the run is marked `failed`.
 */
export async function compensateHandler(payload: CompensatePayload): Promise<void> {
  const { runId, compensateIndex } = payload

  const run = await loadRun(runId)
  if (!run) return
  if (run.status !== 'compensating') return
  if (run.compensationCursor !== compensateIndex) return

  // Phase A — run the compensator outside the transaction (it may be slow).
  let writes: JournalWrite[] = []
  if (compensateIndex >= 0) {
    const step = registry.get(run.workflowName).steps[compensateIndex]
    if (step) {
      const journal = await loadJournal(runId)
      const alreadyDone =
        journal.get(`${step.name}#compensate`)?.status === 'completed'
      if (!alreadyDone) {
        writes = await runCompensator(step, buildContext(run, 1, step.name), journal)
      }
    }
  }

  // Phase B — record the compensation and advance the cursor atomically.
  await transaction(async (trx: Tx) => {
    const locked = await lockRun(trx, runId)
    if (
      !locked ||
      locked.status !== 'compensating' ||
      locked.compensationCursor !== compensateIndex
    ) {
      return
    }

    if (writes.length > 0) await writeJournal(trx, runId, writes)

    const next = compensateIndex - 1
    if (next < 0) {
      await failRun(trx, locked, locked.error ?? 'workflow failed')
    } else {
      await trx`
        UPDATE "_strav_workflow_runs"
        SET "compensation_cursor" = ${next}, "updated_at" = NOW()
        WHERE "id" = ${runId}
      `
      await enqueueCompensate(trx, runId, next)
    }
  })
}
