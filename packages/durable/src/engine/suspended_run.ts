/**
 * Brain composition point — duck-typed, with no `@strav/brain` dependency.
 *
 * `@strav/brain`'s `AgentRunner.run()` returns either an `AgentResult` or a
 * `SuspendedRun` ({ status: 'suspended', pendingToolCalls, state }). When a
 * durable `.step` handler returns a `SuspendedRun`, the engine suspends the
 * whole run and journals the snapshot; resuming the run re-enters the handler
 * so it can call `runner.resume(...)`. The per-agent suspend nests inside the
 * per-workflow suspend.
 */

/** A structural view of a `@strav/brain` `SuspendedRun`. */
export interface SuspendedRunLike {
  status: 'suspended'
  state: unknown
  pendingToolCalls: unknown
}

/** Structurally detect a brain `SuspendedRun` without importing `@strav/brain`. */
export function isSuspendedRun(value: unknown): value is SuspendedRunLike {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return v.status === 'suspended' && 'state' in v && 'pendingToolCalls' in v
}
