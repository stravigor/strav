import type { WorkflowContext } from '@strav/workflow'

// ── Run + journal status ────────────────────────────────────────────────────

/** Lifecycle status of a durable workflow run. */
export type RunStatus =
  | 'pending'
  | 'running'
  | 'suspended'
  | 'compensating'
  | 'completed'
  | 'failed'
  | 'canceled'

/** Status of a single journal entry. */
export type JournalStatus = 'completed' | 'failed'

// ── Durable context ─────────────────────────────────────────────────────────

/**
 * Context passed to durable step handlers. Extends the `@strav/workflow`
 * context (`input` + `results`) with durable-only accessors, so a plain
 * `@strav/workflow` handler is copy-paste portable into a durable workflow.
 */
export interface DurableContext extends WorkflowContext {
  /** The durable run id — stable across crashes/restarts. */
  runId: number
  /** The current retry attempt for the executing step (1-based). */
  attempt: number
  /** The name of the step currently executing. */
  stepName: string
  /** Read a completed step (or signal) result by name. */
  signal<T = unknown>(name: string): T | undefined
  /**
   * The payload passed to the most recent `Durable.resume()` for this run.
   * Used by a brain-agent step to resume a journaled `SuspendedRun`.
   */
  resumeData<T = unknown>(): T | undefined
}

// ── Handler signatures ──────────────────────────────────────────────────────

/** Handler for sequential, parallel, and route steps. */
export type DurableStepHandler = (ctx: DurableContext) => Promise<unknown>

/** Handler for loop steps — receives the iteration input + context. */
export type DurableLoopHandler = (input: unknown, ctx: DurableContext) => Promise<unknown>

/** Route resolver — returns the branch key to dispatch to. */
export type DurableRouteResolver = (ctx: DurableContext) => string | Promise<string>

/** Compensation handler for saga-style rollback. */
export type DurableCompensator = (ctx: DurableContext) => Promise<void>

/** A single entry in a parallel step. */
export interface DurableParallelEntry {
  name: string
  handler: DurableStepHandler
  compensate?: DurableCompensator
}

// ── Step options ────────────────────────────────────────────────────────────

export interface DurableStepOptions {
  /** Saga compensation — run in reverse order if a later step fails. */
  compensate?: DurableCompensator
  /** Max total attempts before the step is declared failed. Default 3. */
  maxRetries?: number
  /** Backoff strategy between retries. Default 'exponential'. */
  retryBackoff?: 'exponential' | 'linear'
}

export interface DurableLoopOptions {
  maxIterations: number
  until?: (result: unknown, iteration: number) => boolean
  feedback?: (result: unknown) => unknown
  mapInput?: (ctx: DurableContext) => unknown
  maxRetries?: number
  retryBackoff?: 'exponential' | 'linear'
}

// ── Step definitions ────────────────────────────────────────────────────────

export interface SequentialStep {
  type: 'step'
  name: string
  handler: DurableStepHandler
  compensate?: DurableCompensator
  maxRetries: number
  retryBackoff: 'exponential' | 'linear'
}

export interface ParallelStep {
  type: 'parallel'
  name: string
  entries: DurableParallelEntry[]
  maxRetries: number
  retryBackoff: 'exponential' | 'linear'
}

export interface RouteStep {
  type: 'route'
  name: string
  resolver: DurableRouteResolver
  branches: Record<string, DurableStepHandler>
  maxRetries: number
  retryBackoff: 'exponential' | 'linear'
}

export interface LoopStep {
  type: 'loop'
  name: string
  handler: DurableLoopHandler
  maxIterations: number
  until?: (result: unknown, iteration: number) => boolean
  feedback?: (result: unknown) => unknown
  mapInput?: (ctx: DurableContext) => unknown
  maxRetries: number
  retryBackoff: 'exponential' | 'linear'
}

/** Durable timer — suspends the run and resumes after `duration`. */
export interface SleepStep {
  type: 'sleep'
  name: string
  duration: number | Date
}

/** Human-in-the-loop pause — suspends until `Durable.resume()` delivers the signal. */
export interface SignalStep {
  type: 'signal'
  name: string
  signal: string
  timeout?: number
}

/** Spawn an independently durable child workflow and wait for it. */
export interface ChildStep {
  type: 'child'
  name: string
  childName: string
  mapInput?: (ctx: DurableContext) => Record<string, unknown>
}

export type DurableStep =
  | SequentialStep
  | ParallelStep
  | RouteStep
  | LoopStep
  | SleepStep
  | SignalStep
  | ChildStep

// ── Public result shapes ────────────────────────────────────────────────────

export interface StartResult {
  runId: number
  status: RunStatus
}

export interface ResumeResult {
  /** Whether the signal was accepted (run suspended on a matching signal). */
  accepted: boolean
  status: RunStatus
}

export interface RunStatusSnapshot {
  runId: number
  workflowName: string
  status: RunStatus
  currentStep: number
  totalSteps: number
  awaitingSignal: string | null
  wakeAt: string | null
  results: Record<string, unknown>
  error: string | null
  parentRunId: number | null
  children: RunStatusSnapshot[]
}

// ── Internal records ────────────────────────────────────────────────────────

/** A hydrated `_strav_workflow_runs` row (snake_case columns → camelCase). */
export interface RunRow {
  id: number
  workflowName: string
  input: Record<string, unknown>
  status: RunStatus
  state: Record<string, unknown>
  currentStep: number
  compensationCursor: number | null
  parentRunId: number | null
  parentStepId: string | null
  awaitingSignal: string | null
  wakeAt: Date | null
  error: string | null
  result: Record<string, unknown> | null
}

/** A hydrated `_strav_workflow_journal` row. */
export interface JournalRecord {
  stepId: string
  status: JournalStatus
  result: unknown
  error: string | null
  attempt: number
}

/** A pending journal write produced by the step driver. */
export interface JournalWrite {
  stepId: string
  status: JournalStatus
  result?: unknown
  error?: string
  attempt: number
}
