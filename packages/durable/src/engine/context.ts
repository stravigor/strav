import type { DurableContext, RunRow } from '../types.ts'

const INTERNAL_PREFIX = '__strav_'

/**
 * Build the `DurableContext` handed to step handlers from a run row.
 *
 * `results` is the run's accumulated `state` with engine-internal keys
 * (e.g. `__strav_resume__`) filtered out, so it reads exactly like a
 * `@strav/workflow` context. `resumeData()` exposes the raw resume payload.
 */
export function buildContext(
  run: RunRow,
  attempt: number,
  stepName: string
): DurableContext {
  const rawState = run.state ?? {}
  const results: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(rawState)) {
    if (!key.startsWith(INTERNAL_PREFIX)) results[key] = value
  }

  return {
    input: run.input ?? {},
    results,
    runId: run.id,
    attempt,
    stepName,
    signal<T = unknown>(name: string): T | undefined {
      return results[name] as T | undefined
    },
    resumeData<T = unknown>(): T | undefined {
      return rawState['__strav_resume__'] as T | undefined
    },
  }
}
