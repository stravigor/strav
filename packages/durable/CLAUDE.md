# @strav/durable

Durable, crash-resumable workflow execution for the Strav framework. The
persistent sibling of `@strav/workflow` — it keeps the same declarative
authoring API but checkpoints every step to Postgres and drives progression
through `@strav/queue` jobs, so a workflow killed mid-execution resumes from the
first incomplete step without re-running completed work or re-issuing LLM/tool
calls.

## Dependencies
- @strav/kernel (peer)
- @strav/database (peer)
- @strav/queue
- @strav/machine
- @strav/workflow

## Commands
- bun test
- bun run typecheck

## Architecture
- src/builder.ts — DurableWorkflow builder (.step/.parallel/.route/.loop/.sleep/.waitForSignal/.childWorkflow)
- src/helpers.ts — durable(name) factory
- src/registry.ts — name → DurableWorkflow registry (queue jobs carry a name)
- src/durable.ts — Durable static facade (start/resume/status/list/cancel/recover)
- src/schema.ts — the two tables (_strav_workflow_runs, _strav_workflow_journal) + ensureTables()
- src/models/ — WorkflowRun (stateful ORM model) + run-lifecycle state machine
- src/engine/ — the durable execution engine (advance/compensate handlers, step driver)
- src/providers/ — DurableProvider

## Model
Explicit-journal durable execution (DBOS/Inngest style — no determinism sandbox).
One top-level step = one `durable:advance` queue job. Each step's result is
checkpointed in `_strav_workflow_journal`; `UNIQUE (run_id, step_id)` makes
redelivery idempotent. The journal write + run-row update + next-job enqueue
commit in a single transaction, so the queue inherits crash-safety.

## Contract
Step handlers must be **idempotent**. The engine guarantees journaling and
job enqueue happen exactly once, but a step *handler* can run more than once
on crash/redelivery (at-least-once execution, same as DBOS/Inngest).

## Conventions
- sleep / waitForSignal / childWorkflow are declarative builder step types,
  not mid-handler ctx.* calls — every suspend/resume point is a step boundary.
- The engine hot path uses raw SQL for atomic, FOR UPDATE-locked transactions.
- Framework-internal tables use the _strav_ prefix.
