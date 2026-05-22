import { DurableWorkflow } from './builder.ts'
import { registry } from './registry.ts'

/**
 * Create a durable workflow and register it under `name`.
 *
 * @example
 * export const milestone = durable('milestone')
 *   .step('discover', async (ctx) => discover(ctx.input))
 *   .step('ship', async (ctx) => ship(ctx))
 */
export function durable(name: string): DurableWorkflow {
  const workflow = new DurableWorkflow(name)
  registry.register(workflow)
  return workflow
}
