import { Workflow as BaseWorkflow } from '@strav/workflow'
import type { WorkflowContext as BaseContext } from '@strav/workflow'
import { AgentRunner } from './helpers.ts'
import type { Agent } from './agent.ts'
import type { AgentResult, SuspendedRun, WorkflowResult, Usage } from './types.ts'

// ── AI Workflow Context ─────────────────────────────────────────────────────

export interface WorkflowContext {
  input: Record<string, unknown>
  results: Record<string, AgentResult>
}

type StepMapInput = (ctx: WorkflowContext) => Record<string, unknown> | string

// ── Utilities ───────────────────────────────────────────────────────────────

function resolveInput(mapInput: StepMapInput | undefined, ctx: BaseContext): string {
  if (!mapInput) return JSON.stringify(ctx.input)
  const mapped = mapInput(ctx as unknown as WorkflowContext)
  return typeof mapped === 'string' ? mapped : JSON.stringify(mapped)
}

function addUsage(total: Usage, add: Usage): void {
  total.inputTokens += add.inputTokens
  total.outputTokens += add.outputTokens
  total.totalTokens += add.totalTokens
}

// Workflow orchestration runs agents to completion; suspension is a standalone
// primitive on AgentRunner. Surface a clear error rather than silently swallowing.
function assertCompleted(
  result: AgentResult | SuspendedRun,
  stepName: string
): asserts result is AgentResult {
  if ((result as SuspendedRun).status === 'suspended') {
    throw new Error(
      `Workflow step "${stepName}" suspended — Workflow does not support agent suspension. ` +
        `Use AgentRunner.run()/resume() directly, or ensure workflow agents don't define shouldSuspend.`
    )
  }
}

// ── Workflow Builder ────────────────────────────────────────────────────────

/**
 * Multi-agent workflow orchestrator built on `@strav/workflow`.
 *
 * Supports sequential steps, parallel fan-out, routing, and loops.
 * Each step wraps an Agent execution through the general-purpose workflow engine.
 *
 * @example
 * const result = await brain.workflow('content-pipeline')
 *   .step('research', ResearchAgent)
 *   .step('write', WriterAgent, (ctx) => ({
 *     topic: ctx.results.research.data.summary,
 *   }))
 *   .step('review', ReviewerAgent)
 *   .run({ topic: 'AI in healthcare' })
 */
export class Workflow {
  private pipeline: BaseWorkflow
  private totalUsage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }

  constructor(name: string) {
    this.pipeline = new BaseWorkflow(name)
  }

  /**
   * Add a sequential step. Runs after all previous steps complete.
   * Use `mapInput` to transform context into the agent's input.
   */
  step(name: string, agent: new () => Agent, mapInput?: StepMapInput): this {
    this.pipeline.step(name, async (ctx: BaseContext) => {
      const inputText = resolveInput(mapInput, ctx)
      const result = await new AgentRunner(agent).input(inputText).run()
      assertCompleted(result, name)
      addUsage(this.totalUsage, result.usage)
      return result
    })
    return this
  }

  /**
   * Run multiple agents in parallel. All agents receive the same context.
   * Each agent's result is stored under its name in the workflow results.
   */
  parallel(
    name: string,
    agents: { name: string; agent: new () => Agent; mapInput?: StepMapInput }[]
  ): this {
    this.pipeline.parallel(
      name,
      agents.map(a => ({
        name: a.name,
        handler: async (ctx: BaseContext) => {
          const inputText = resolveInput(a.mapInput, ctx)
          const result = await new AgentRunner(a.agent).input(inputText).run()
          assertCompleted(result, `${name}.${a.name}`)
          addUsage(this.totalUsage, result.usage)
          return result
        },
      }))
    )
    return this
  }

  /**
   * Route to a specialized agent based on a router agent's output.
   * The router agent should return structured output with a `route` field
   * that matches one of the branch keys.
   */
  route(
    name: string,
    router: new () => Agent,
    branches: Record<string, new () => Agent>,
    mapInput?: StepMapInput
  ): this {
    // Router step: run the router agent, store as `${name}:router`
    this.pipeline.step(`${name}:router`, async (ctx: BaseContext) => {
      const inputText = resolveInput(mapInput, ctx)
      const result = await new AgentRunner(router).input(inputText).run()
      assertCompleted(result, `${name}:router`)
      addUsage(this.totalUsage, result.usage)
      return result
    })

    // Branch step: dispatch to the matching branch agent
    this.pipeline.route(
      name,
      (ctx: BaseContext) => {
        const routerResult = ctx.results[`${name}:router`] as AgentResult
        return routerResult.data?.route ?? routerResult.text?.trim() ?? ''
      },
      Object.fromEntries(
        Object.entries(branches).map(([key, BranchAgent]) => [
          key,
          async (ctx: BaseContext) => {
            const inputText = resolveInput(mapInput, ctx)
            const result = await new AgentRunner(BranchAgent).input(inputText).run()
            assertCompleted(result, `${name}:${key}`)
            addUsage(this.totalUsage, result.usage)
            return result
          },
        ])
      )
    )
    return this
  }

  /**
   * Run an agent in a loop until a condition is met or max iterations reached.
   * Use `feedback` to transform the result into the next iteration's input.
   */
  loop(
    name: string,
    agent: new () => Agent,
    options: {
      maxIterations: number
      until?: (result: AgentResult, iteration: number) => boolean
      feedback?: (result: AgentResult) => string
      mapInput?: StepMapInput
    }
  ): this {
    this.pipeline.loop(
      name,
      async (input: unknown, _ctx: BaseContext) => {
        const result = await new AgentRunner(agent).input(String(input)).run()
        assertCompleted(result, name)
        addUsage(this.totalUsage, result.usage)
        return result
      },
      {
        maxIterations: options.maxIterations,
        until: options.until
          ? (result: unknown, iteration: number) => options.until!(result as AgentResult, iteration)
          : undefined,
        feedback: options.feedback
          ? (result: unknown) => options.feedback!(result as AgentResult)
          : undefined,
        mapInput: options.mapInput
          ? (ctx: BaseContext) => resolveInput(options.mapInput, ctx)
          : (ctx: BaseContext) => JSON.stringify(ctx.input),
      }
    )
    return this
  }

  /** Execute the workflow. */
  async run(input: Record<string, unknown>): Promise<WorkflowResult> {
    this.totalUsage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
    const result = await this.pipeline.run(input)
    return {
      results: result.results as Record<string, AgentResult>,
      usage: this.totalUsage,
      duration: result.duration,
    }
  }
}
