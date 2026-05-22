import type {
  DurableContext,
  DurableStep,
  JournalRecord,
  JournalWrite,
} from '../types.ts'

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Run the compensator(s) for one step during saga rollback.
 *
 * Mirrors `@strav/workflow`'s compensation surface: only `step` (sequential)
 * and `parallel` entries carry compensators, and only journaled-completed
 * units are compensated. The result is a single `<step>#compensate` journal
 * write — so the compensation chain is itself crash-safe (a redelivered
 * compensate job sees the marker and skips).
 *
 * A throwing compensator is best-effort: its error is recorded on the journal
 * row and the rollback still advances (it does not get stuck).
 */
export async function runCompensator(
  step: DurableStep,
  ctx: DurableContext,
  journal: Map<string, JournalRecord>
): Promise<JournalWrite[]> {
  const errors: string[] = []

  if (step.type === 'step') {
    if (journal.get(step.name)?.status === 'completed' && step.compensate) {
      try {
        await step.compensate(ctx)
      } catch (err) {
        errors.push(message(err))
      }
    }
  } else if (step.type === 'parallel') {
    for (const entry of step.entries) {
      const done = journal.get(`${step.name}#${entry.name}`)?.status === 'completed'
      if (done && entry.compensate) {
        try {
          await entry.compensate(ctx)
        } catch (err) {
          errors.push(`${entry.name}: ${message(err)}`)
        }
      }
    }
  }
  // route / loop / sleep / signal / child have no compensators.

  return [
    {
      stepId: `${step.name}#compensate`,
      status: errors.length > 0 ? 'failed' : 'completed',
      error: errors.length > 0 ? errors.join('; ') : undefined,
      attempt: 1,
    },
  ]
}
