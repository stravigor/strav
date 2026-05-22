import { sql } from '@strav/database'
import type { JournalRecord, JournalWrite } from '../types.ts'
import { parseJson } from '../util.ts'

/**
 * Load every journal entry for a run, keyed by `step_id`. Used (unlocked) at
 * the start of an advance to short-circuit completed steps and sub-units.
 */
export async function loadJournal(runId: number): Promise<Map<string, JournalRecord>> {
  const rows = (await sql`
    SELECT "step_id", "status", "result", "error", "attempt"
    FROM "_strav_workflow_journal"
    WHERE "run_id" = ${runId}
  `) as Record<string, unknown>[]

  const map = new Map<string, JournalRecord>()
  for (const r of rows) {
    map.set(r.step_id as string, {
      stepId: r.step_id as string,
      status: r.status as JournalRecord['status'],
      result: parseJson(r.result),
      error: (r.error as string | null) ?? null,
      attempt: Number(r.attempt),
    })
  }
  return map
}

/**
 * Append journal entries inside a transaction. `ON CONFLICT DO NOTHING` on
 * `UNIQUE (run_id, step_id)` makes a redelivered step idempotent — the first
 * write wins, later writes for the same `step_id` are no-ops.
 */
export async function writeJournal(
  trx: { (strings: TemplateStringsArray, ...values: unknown[]): Promise<unknown> },
  runId: number,
  writes: JournalWrite[]
): Promise<void> {
  for (const w of writes) {
    await trx`
      INSERT INTO "_strav_workflow_journal"
        ("run_id", "step_id", "status", "result", "error", "attempt")
      VALUES (
        ${runId},
        ${w.stepId},
        ${w.status},
        ${w.result === undefined ? null : JSON.stringify(w.result)},
        ${w.error ?? null},
        ${w.attempt}
      )
      ON CONFLICT ("run_id", "step_id") DO NOTHING
    `
  }
}
