# @strav/durable

## 0.4.26

Initial release — durable, crash-resumable workflow execution.

- `durable(name)` builder mirroring the `@strav/workflow` authoring API
  (`.step` / `.parallel` / `.route` / `.loop` + `compensate`), plus durable-only
  step types `.sleep`, `.waitForSignal`, and `.childWorkflow`.
- Explicit-journal execution model (DBOS/Inngest style, no determinism sandbox):
  every step is checkpointed to `_strav_workflow_journal`; `UNIQUE (run_id, step_id)`
  makes redelivery idempotent.
- Queue-driven progression — one top-level step = one `durable:advance`
  `@strav/queue` job; the journal write + run-row update + next-job enqueue
  commit in a single transaction, so the engine inherits crash-safety from the
  queue. A workflow killed mid-execution resumes from the first incomplete step.
- Suspend/resume: `waitForSignal` parks a run for an unbounded time holding no
  process; `Durable.resume()` delivers the signal.
- Durable timers via `.sleep` (survives process restarts).
- Independently durable, parent-linked child workflows.
- Journaled saga compensation — rollback is itself crash-safe.
- Composes with `@strav/brain` — a step returning a `SuspendedRun` suspends the
  run; resume re-enters the step (duck-typed, no `@strav/brain` dependency).
- `WorkflowRun` — a `stateful()` ORM model over the run record, with a
  `@strav/machine` run-status lifecycle.
- `Durable.start` / `resume` / `status` / `list` / `cancel` / `recover`.
