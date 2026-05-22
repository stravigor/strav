import { transaction } from '@strav/database'
import { registry } from '../registry.ts'
import { loadJournal, writeJournal } from '../models/journal.ts'
import { buildContext } from './context.ts'
import { enqueueAdvance } from './enqueue.ts'
import { applyPatch, beginCompensation, completeRun } from './finalize.ts'
import { loadRun, lockRun, type Tx } from './run_store.ts'
import { runDurableStep, type StepOutcome } from './step_driver.ts'

/** Payload of a `durable:advance` job. */
export interface AdvancePayload {
  runId: number
  stepIndex: number
  attempt?: number
}

/**
 * The `durable:advance` queue handler — runs one top-level step of a run.
 *
 * Phase A (no lock): load the run, guard against stale redelivery, execute the
 * step. The step handler may take minutes — no row lock is held during it.
 * Phase B (`applyOutcome`, row-locked transaction): apply the outcome —
 * journal, advance/suspend/retry/compensate, enqueue the continuation — atomically.
 */
export async function advanceHandler(payload: AdvancePayload): Promise<void> {
  const { runId, stepIndex } = payload
  const attempt = payload.attempt ?? 1

  const run = await loadRun(runId)
  if (!run) return
  // Only a `running` run advances; `suspended`/terminal/`compensating` runs
  // are handled by resume / the compensation chain / not at all.
  if (run.status !== 'running') return
  // Stale redelivery — the run already moved past this step.
  if (run.currentStep !== stepIndex) return

  const workflow = registry.get(run.workflowName)
  const steps = workflow.steps

  // Past the last step — the run is done.
  if (stepIndex >= steps.length) {
    await completeRun(runId)
    return
  }

  const step = steps[stepIndex]!
  const journal = await loadJournal(runId)
  const ctx = buildContext(run, attempt, step.name)
  const outcome = await runDurableStep(step, ctx, journal)
  await applyOutcome(runId, stepIndex, outcome)
}

/** Phase B — apply a step outcome atomically under a `FOR UPDATE` lock. */
async function applyOutcome(
  runId: number,
  stepIndex: number,
  outcome: StepOutcome
): Promise<void> {
  await transaction(async (trx: Tx) => {
    const run = await lockRun(trx, runId)
    // Re-check under the lock: a resume / cancel / concurrent duplicate may
    // have moved the run since Phase A.
    if (!run || run.status !== 'running' || run.currentStep !== stepIndex) return

    switch (outcome.kind) {
      case 'advance': {
        await writeJournal(trx, runId, outcome.journal)
        const newState = applyPatch(run.state, outcome.resultPatch)
        delete newState['__strav_resume__']
        const next = stepIndex + 1
        await trx`
          UPDATE "_strav_workflow_runs"
          SET "state" = ${JSON.stringify(newState)}, "current_step" = ${next},
              "updated_at" = NOW()
          WHERE "id" = ${runId}
        `
        await enqueueAdvance(trx, runId, next)
        break
      }

      case 'sleep': {
        await writeJournal(trx, runId, outcome.journal)
        const newState = applyPatch(run.state, outcome.resultPatch)
        const next = stepIndex + 1
        const delay = Math.max(0, outcome.wakeAt.getTime() - Date.now())
        await trx`
          UPDATE "_strav_workflow_runs"
          SET "state" = ${JSON.stringify(newState)}, "current_step" = ${next},
              "wake_at" = ${outcome.wakeAt}, "updated_at" = NOW()
          WHERE "id" = ${runId}
        `
        await enqueueAdvance(trx, runId, next, { delay })
        break
      }

      case 'suspend-signal': {
        await trx`
          UPDATE "_strav_workflow_runs"
          SET "status" = 'suspended', "awaiting_signal" = ${outcome.signal},
              "updated_at" = NOW()
          WHERE "id" = ${runId}
        `
        break
      }

      case 'suspend-agent': {
        const newState = applyPatch(run.state, { [outcome.stepName]: outcome.snapshot })
        await trx`
          UPDATE "_strav_workflow_runs"
          SET "status" = 'suspended', "awaiting_signal" = ${outcome.stepName},
              "state" = ${JSON.stringify(newState)}, "updated_at" = NOW()
          WHERE "id" = ${runId}
        `
        break
      }

      case 'await-child': {
        const childRows = (await trx`
          INSERT INTO "_strav_workflow_runs"
            ("workflow_name", "input", "status", "state", "current_step",
             "parent_run_id", "parent_step_id")
          VALUES (
            ${outcome.childName}, ${JSON.stringify(outcome.childInput)},
            'running', '{}', 0, ${runId}, ${outcome.childStepId}
          )
          RETURNING "id"
        `) as Record<string, unknown>[]
        const childId = Number(childRows[0]!.id)
        await enqueueAdvance(trx, childId, 0)
        await trx`
          UPDATE "_strav_workflow_runs"
          SET "status" = 'suspended', "updated_at" = NOW()
          WHERE "id" = ${runId}
        `
        break
      }

      case 'retry': {
        await writeJournal(trx, runId, outcome.journal)
        await enqueueAdvance(trx, runId, stepIndex, {
          attempt: outcome.attempt,
          delay: outcome.backoffMs,
        })
        break
      }

      case 'compensate': {
        await writeJournal(trx, runId, outcome.journal)
        await beginCompensation(trx, run, stepIndex, outcome.failure)
        break
      }
    }
  })
}
