import type { DateTime } from 'luxon'
import { BaseModel, cast } from '@strav/database'
import { stateful } from '@strav/machine'
import type { Machine } from '@strav/machine'
import { runMachine } from './run_machine.ts'

/**
 * ORM model over `_strav_workflow_runs` — the durable, queryable record of a
 * workflow run (Albastr's "pollable open-Turn live record").
 *
 * Mixed with `stateful()` so a run's status is a first-class state machine:
 * `run.is('running')`, `run.availableTransitions()`, `WorkflowRun.inState(...)`.
 * The engine hot path writes status via raw SQL for atomicity; this model is
 * for reads and for application code that wants to poll or query runs.
 */
export class WorkflowRun extends stateful(BaseModel, runMachine as Machine) {
  static override get tableName(): string {
    return '_strav_workflow_runs'
  }

  declare id: number
  declare workflowName: string
  @cast('json') declare input: Record<string, unknown>
  declare status: string
  @cast('json') declare state: Record<string, unknown>
  declare currentStep: number
  declare compensationCursor: number | null
  declare parentRunId: number | null
  declare parentStepId: string | null
  declare awaitingSignal: string | null
  declare wakeAt: DateTime | null
  declare error: string | null
  @cast('json') declare result: Record<string, unknown> | null
  declare createdAt: DateTime
  declare updatedAt: DateTime
}
