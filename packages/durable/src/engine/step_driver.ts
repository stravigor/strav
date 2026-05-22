import type {
  DurableContext,
  DurableStep,
  JournalRecord,
  JournalWrite,
} from '../types.ts'
import { backoffDelay } from '../util.ts'
import { isSuspendedRun } from './suspended_run.ts'

/**
 * The result of executing one top-level step. The engine applies it
 * atomically in Phase B (a row-locked transaction).
 */
export type StepOutcome =
  /** Step (and all sub-units) completed — journal results and move forward. */
  | { kind: 'advance'; journal: JournalWrite[]; resultPatch: Record<string, unknown> }
  /** A durable timer — journal, move forward, enqueue a delayed continuation. */
  | { kind: 'sleep'; journal: JournalWrite[]; resultPatch: Record<string, unknown>; wakeAt: Date }
  /** Suspend awaiting an external signal (human-in-the-loop). */
  | { kind: 'suspend-signal'; signal: string }
  /** Suspend on a brain agent `SuspendedRun` — resume re-enters this step. */
  | { kind: 'suspend-agent'; stepName: string; snapshot: unknown }
  /** Spawn a child workflow and wait for it. */
  | { kind: 'await-child'; childName: string; childInput: Record<string, unknown>; childStepId: string }
  /** Step failed but retries remain — re-enqueue the same step with backoff. */
  | { kind: 'retry'; journal: JournalWrite[]; attempt: number; backoffMs: number; failure: string }
  /** Step failed terminally — begin saga compensation. */
  | { kind: 'compensate'; journal: JournalWrite[]; failure: string }

type RetryableStep = {
  name: string
  maxRetries: number
  retryBackoff: 'exponential' | 'linear'
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Decide between retry and compensation when a step's handler throws. */
function failureOutcome(
  step: RetryableStep,
  attempt: number,
  err: unknown,
  partialJournal: JournalWrite[]
): StepOutcome {
  const failure = message(err)
  if (attempt < step.maxRetries) {
    return {
      kind: 'retry',
      journal: partialJournal,
      attempt: attempt + 1,
      backoffMs: backoffDelay(attempt, step.retryBackoff),
      failure,
    }
  }
  return {
    kind: 'compensate',
    journal: [
      ...partialJournal,
      { stepId: step.name, status: 'failed', error: failure, attempt },
    ],
    failure,
  }
}

/**
 * Execute one top-level step against the journal. Completed sub-units
 * (parallel entries, loop iterations, the route decision) are read back from
 * the journal rather than re-run, so redelivery fast-forwards to the first
 * incomplete unit.
 */
export async function runDurableStep(
  step: DurableStep,
  ctx: DurableContext,
  journal: Map<string, JournalRecord>
): Promise<StepOutcome> {
  switch (step.type) {
    case 'step':
      return runSequential(step, ctx)
    case 'parallel':
      return runParallel(step, ctx, journal)
    case 'route':
      return runRoute(step, ctx, journal)
    case 'loop':
      return runLoop(step, ctx, journal)
    case 'sleep':
      return runSleep(step)
    case 'signal':
      return { kind: 'suspend-signal', signal: step.signal }
    case 'child':
      return runChild(step, ctx)
  }
}

// ── step ────────────────────────────────────────────────────────────────────

async function runSequential(
  step: Extract<DurableStep, { type: 'step' }>,
  ctx: DurableContext
): Promise<StepOutcome> {
  try {
    const result = await step.handler(ctx)
    if (isSuspendedRun(result)) {
      return { kind: 'suspend-agent', stepName: step.name, snapshot: result }
    }
    return {
      kind: 'advance',
      journal: [{ stepId: step.name, status: 'completed', result, attempt: ctx.attempt }],
      resultPatch: { [step.name]: result },
    }
  } catch (err) {
    return failureOutcome(step, ctx.attempt, err, [])
  }
}

// ── parallel ────────────────────────────────────────────────────────────────

async function runParallel(
  step: Extract<DurableStep, { type: 'parallel' }>,
  ctx: DurableContext,
  journal: Map<string, JournalRecord>
): Promise<StepOutcome> {
  const settled = await Promise.all(
    step.entries.map(async entry => {
      const jid = `${step.name}#${entry.name}`
      const existing = journal.get(jid)
      if (existing?.status === 'completed') {
        return { entry, ok: true as const, result: existing.result, fresh: false }
      }
      try {
        const result = await entry.handler(ctx)
        return { entry, ok: true as const, result, fresh: true }
      } catch (err) {
        return { entry, ok: false as const, err, fresh: true }
      }
    })
  )

  const writes: JournalWrite[] = []
  const resultPatch: Record<string, unknown> = {}
  let firstError: unknown

  for (const s of settled) {
    if (s.ok) {
      resultPatch[s.entry.name] = s.result
      if (s.fresh) {
        writes.push({
          stepId: `${step.name}#${s.entry.name}`,
          status: 'completed',
          result: s.result,
          attempt: ctx.attempt,
        })
      }
    } else if (firstError === undefined) {
      firstError = s.err
    }
  }

  if (firstError === undefined) {
    writes.push({
      stepId: step.name,
      status: 'completed',
      result: resultPatch,
      attempt: ctx.attempt,
    })
    return { kind: 'advance', journal: writes, resultPatch }
  }
  return failureOutcome(step, ctx.attempt, firstError, writes)
}

// ── route ───────────────────────────────────────────────────────────────────

async function runRoute(
  step: Extract<DurableStep, { type: 'route' }>,
  ctx: DurableContext,
  journal: Map<string, JournalRecord>
): Promise<StepOutcome> {
  const routeJid = `${step.name}#route`
  const writes: JournalWrite[] = []
  let routeKey: string

  const existingRoute = journal.get(routeJid)
  try {
    if (existingRoute?.status === 'completed') {
      routeKey = existingRoute.result as string
    } else {
      routeKey = await step.resolver(ctx)
      writes.push({ stepId: routeJid, status: 'completed', result: routeKey, attempt: ctx.attempt })
    }
  } catch (err) {
    return failureOutcome(step, ctx.attempt, err, [])
  }

  const branch = step.branches[routeKey]
  try {
    let result: unknown = null
    const existingBranch = journal.get(step.name)
    if (existingBranch?.status === 'completed') {
      result = existingBranch.result
    } else if (branch) {
      result = await branch(ctx)
    }
    writes.push({ stepId: step.name, status: 'completed', result, attempt: ctx.attempt })
    return {
      kind: 'advance',
      journal: writes,
      resultPatch: branch ? { [step.name]: result } : {},
    }
  } catch (err) {
    // Persist the route decision so a retry takes the same branch.
    return failureOutcome(step, ctx.attempt, err, writes)
  }
}

// ── loop ────────────────────────────────────────────────────────────────────

async function runLoop(
  step: Extract<DurableStep, { type: 'loop' }>,
  ctx: DurableContext,
  journal: Map<string, JournalRecord>
): Promise<StepOutcome> {
  let currentInput: unknown = step.mapInput ? step.mapInput(ctx) : ctx.input
  let lastResult: unknown
  let ran = false
  const writes: JournalWrite[] = []

  for (let i = 0; i < step.maxIterations; i++) {
    ran = true
    const jid = `${step.name}#iter${i}`
    const existing = journal.get(jid)

    if (existing?.status === 'completed') {
      lastResult = existing.result
    } else {
      try {
        lastResult = await step.handler(currentInput, ctx)
      } catch (err) {
        return failureOutcome(step, ctx.attempt, err, writes)
      }
      writes.push({ stepId: jid, status: 'completed', result: lastResult, attempt: ctx.attempt })
    }

    if (step.until?.(lastResult, i + 1)) break
    if (step.feedback) currentInput = step.feedback(lastResult)
  }

  writes.push({ stepId: step.name, status: 'completed', result: lastResult ?? null, attempt: ctx.attempt })
  return {
    kind: 'advance',
    journal: writes,
    resultPatch: ran ? { [step.name]: lastResult } : {},
  }
}

// ── sleep ───────────────────────────────────────────────────────────────────

function runSleep(step: Extract<DurableStep, { type: 'sleep' }>): StepOutcome {
  const wakeAt =
    step.duration instanceof Date
      ? step.duration
      : new Date(Date.now() + step.duration)
  return {
    kind: 'sleep',
    journal: [
      {
        stepId: step.name,
        status: 'completed',
        result: { wakeAt: wakeAt.toISOString() },
        attempt: 1,
      },
    ],
    resultPatch: {},
    wakeAt,
  }
}

// ── child ───────────────────────────────────────────────────────────────────

function runChild(
  step: Extract<DurableStep, { type: 'child' }>,
  ctx: DurableContext
): StepOutcome {
  const childInput = step.mapInput ? step.mapInput(ctx) : ctx.input
  return {
    kind: 'await-child',
    childName: step.childName,
    childInput,
    childStepId: step.name,
  }
}
