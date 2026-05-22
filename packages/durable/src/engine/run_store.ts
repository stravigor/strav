import { sql } from '@strav/database'
import type { RunRow } from '../types.ts'
import { parseJson } from '../util.ts'

/** A Bun SQL transaction handle (tagged-template callable). */
export type Tx = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown>

/** Hydrate a raw `_strav_workflow_runs` row into a typed `RunRow`. */
export function hydrateRun(row: Record<string, unknown>): RunRow {
  return {
    id: Number(row.id),
    workflowName: row.workflow_name as string,
    input: parseJson<Record<string, unknown>>(row.input) ?? {},
    status: row.status as RunRow['status'],
    state: parseJson<Record<string, unknown>>(row.state) ?? {},
    currentStep: Number(row.current_step),
    compensationCursor:
      row.compensation_cursor == null ? null : Number(row.compensation_cursor),
    parentRunId: row.parent_run_id == null ? null : Number(row.parent_run_id),
    parentStepId: (row.parent_step_id as string | null) ?? null,
    awaitingSignal: (row.awaiting_signal as string | null) ?? null,
    wakeAt: (row.wake_at as Date | null) ?? null,
    error: (row.error as string | null) ?? null,
    result: parseJson<Record<string, unknown>>(row.result) ?? null,
  }
}

/** Load a run by id (unlocked read). */
export async function loadRun(runId: number): Promise<RunRow | null> {
  const rows = (await sql`
    SELECT * FROM "_strav_workflow_runs" WHERE "id" = ${runId}
  `) as Record<string, unknown>[]
  return rows.length > 0 ? hydrateRun(rows[0]!) : null
}

/** Load a run `FOR UPDATE` inside a transaction (row-locked). */
export async function lockRun(trx: Tx, runId: number): Promise<RunRow | null> {
  const rows = (await trx`
    SELECT * FROM "_strav_workflow_runs" WHERE "id" = ${runId} FOR UPDATE
  `) as Record<string, unknown>[]
  return rows.length > 0 ? hydrateRun(rows[0]!) : null
}
