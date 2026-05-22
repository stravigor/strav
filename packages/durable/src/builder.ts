import { DurableError } from './errors.ts'
import type {
  DurableStep,
  DurableStepHandler,
  DurableLoopHandler,
  DurableRouteResolver,
  DurableParallelEntry,
  DurableStepOptions,
  DurableLoopOptions,
} from './types.ts'

const DEFAULT_MAX_RETRIES = 3

/**
 * Durable workflow builder.
 *
 * Mirrors the `@strav/workflow` authoring API (`.step` / `.parallel` /
 * `.route` / `.loop` + `compensate`) so plain workflow code is copy-paste
 * portable, and adds durable-only step types: `.sleep`, `.waitForSignal`,
 * and `.childWorkflow`.
 *
 * Built workflows are flat ordered step lists — there is no re-runnable
 * function body, so durability needs no determinism sandbox.
 *
 * @example
 * durable('milestone')
 *   .step('discover', async (ctx) => discover(ctx.input))
 *   .parallel('build', [
 *     { name: 'api', handler: async (ctx) => buildApi(ctx) },
 *     { name: 'ui',  handler: async (ctx) => buildUi(ctx) },
 *   ])
 *   .waitForSignal('signoff', 'founder-signoff')
 *   .step('ship', async (ctx) => ship(ctx))
 */
export class DurableWorkflow {
  readonly name: string
  private readonly _steps: DurableStep[] = []
  private readonly _names = new Set<string>()

  constructor(name: string) {
    this.name = name
  }

  /** The ordered, immutable step list. */
  get steps(): readonly DurableStep[] {
    return this._steps
  }

  private claim(name: string): void {
    if (this._names.has(name)) {
      throw new DurableError(
        `Duplicate step name "${name}" in durable workflow "${this.name}".`
      )
    }
    this._names.add(name)
  }

  /** Add a sequential step. Its result is stored in `ctx.results[name]`. */
  step(name: string, handler: DurableStepHandler, options?: DurableStepOptions): this {
    this.claim(name)
    this._steps.push({
      type: 'step',
      name,
      handler,
      compensate: options?.compensate,
      maxRetries: options?.maxRetries ?? DEFAULT_MAX_RETRIES,
      retryBackoff: options?.retryBackoff ?? 'exponential',
    })
    return this
  }

  /** Run multiple handlers in parallel; each result is stored under its entry name. */
  parallel(
    name: string,
    entries: DurableParallelEntry[],
    options?: Pick<DurableStepOptions, 'maxRetries' | 'retryBackoff'>
  ): this {
    this.claim(name)
    if (entries.length === 0) {
      throw new DurableError(`Parallel step "${name}" must have at least one entry.`)
    }
    this._steps.push({
      type: 'parallel',
      name,
      entries,
      maxRetries: options?.maxRetries ?? DEFAULT_MAX_RETRIES,
      retryBackoff: options?.retryBackoff ?? 'exponential',
    })
    return this
  }

  /** Route to a branch based on a resolver's return value. */
  route(
    name: string,
    resolver: DurableRouteResolver,
    branches: Record<string, DurableStepHandler>,
    options?: Pick<DurableStepOptions, 'maxRetries' | 'retryBackoff'>
  ): this {
    this.claim(name)
    this._steps.push({
      type: 'route',
      name,
      resolver,
      branches,
      maxRetries: options?.maxRetries ?? DEFAULT_MAX_RETRIES,
      retryBackoff: options?.retryBackoff ?? 'exponential',
    })
    return this
  }

  /** Run a handler in a loop until a condition is met or max iterations reached. */
  loop(name: string, handler: DurableLoopHandler, options: DurableLoopOptions): this {
    this.claim(name)
    this._steps.push({
      type: 'loop',
      name,
      handler,
      maxIterations: options.maxIterations,
      until: options.until,
      feedback: options.feedback,
      mapInput: options.mapInput,
      maxRetries: options.maxRetries ?? DEFAULT_MAX_RETRIES,
      retryBackoff: options.retryBackoff ?? 'exponential',
    })
    return this
  }

  /** Durable timer — suspend the run and resume after `duration` (ms or a Date). */
  sleep(name: string, duration: number | Date): this {
    this.claim(name)
    this._steps.push({ type: 'sleep', name, duration })
    return this
  }

  /**
   * Suspend the run until `Durable.resume(runId, signal, data)` is called.
   * Holds no process while suspended — resumes exactly, even days later.
   */
  waitForSignal(name: string, signal: string, options?: { timeout?: number }): this {
    this.claim(name)
    this._steps.push({ type: 'signal', name, signal, timeout: options?.timeout })
    return this
  }

  /**
   * Spawn an independently durable child workflow and wait for it to finish.
   * The child result is stored in `ctx.results[name]`.
   */
  childWorkflow(
    name: string,
    childName: string,
    mapInput?: (ctx: import('./types.ts').DurableContext) => Record<string, unknown>
  ): this {
    this.claim(name)
    this._steps.push({ type: 'child', name, childName, mapInput })
    return this
  }
}
