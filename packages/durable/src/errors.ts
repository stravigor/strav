import { StravError } from '@strav/kernel'

/** Base error for the durable execution engine. */
export class DurableError extends StravError {}

/** Thrown when a run id does not exist. */
export class RunNotFoundError extends DurableError {
  constructor(public readonly runId: number) {
    super(`Durable run ${runId} not found.`)
  }
}

/** Thrown when a workflow name has no registered definition in this process. */
export class WorkflowNotRegisteredError extends DurableError {
  constructor(public readonly workflowName: string) {
    super(
      `Durable workflow "${workflowName}" is not registered. ` +
        `Import the module that defines it before starting or advancing a run.`
    )
  }
}
