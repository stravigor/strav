import type { DurableWorkflow } from './builder.ts'
import { WorkflowNotRegisteredError } from './errors.ts'

/**
 * Process-wide registry of durable workflow definitions.
 *
 * A `durable:advance` queue job carries only a workflow *name* (not a
 * closure), so the worker process must be able to look the definition up
 * by name. Importing the module that calls `durable(...)` registers it.
 */
const workflows = new Map<string, DurableWorkflow>()

export const registry = {
  /** Register (or replace) a workflow definition by name. */
  register(workflow: DurableWorkflow): void {
    workflows.set(workflow.name, workflow)
  },

  /** Look up a workflow definition, throwing if it is not registered. */
  get(name: string): DurableWorkflow {
    const wf = workflows.get(name)
    if (!wf) throw new WorkflowNotRegisteredError(name)
    return wf
  },

  /** Whether a workflow name is registered. */
  has(name: string): boolean {
    return workflows.has(name)
  },

  /** Clear all registrations. For testing only. */
  reset(): void {
    workflows.clear()
  },
}
