import { test, expect, describe } from 'bun:test'
import { durable, registry, DurableError } from '../src/index.ts'

describe('DurableWorkflow builder', () => {
  test('builds a flat, ordered step list of every step type', () => {
    const wf = durable('builder-all')
      .step('a', async () => 1)
      .parallel('b', [{ name: 'x', handler: async () => 2 }])
      .route('c', async () => 'k', { k: async () => 3 })
      .loop('d', async () => 4, { maxIterations: 1 })
      .sleep('e', 1_000)
      .waitForSignal('f', 'some-signal')
      .childWorkflow('g', 'child-wf')

    expect(wf.steps.map(s => s.type)).toEqual([
      'step',
      'parallel',
      'route',
      'loop',
      'sleep',
      'signal',
      'child',
    ])
    expect(wf.steps.map(s => s.name)).toEqual(['a', 'b', 'c', 'd', 'e', 'f', 'g'])
  })

  test('rejects duplicate step names', () => {
    expect(() =>
      durable('builder-dup').step('a', async () => 1).step('a', async () => 2)
    ).toThrow(DurableError)
  })

  test('rejects an empty parallel step', () => {
    expect(() => durable('builder-empty').parallel('p', [])).toThrow(DurableError)
  })

  test('durable() registers the workflow under its name', () => {
    durable('builder-registered').step('a', async () => 1)
    expect(registry.has('builder-registered')).toBe(true)
  })

  test('defaults maxRetries to 3 and backoff to exponential', () => {
    const wf = durable('builder-defaults').step('a', async () => 1)
    const step = wf.steps[0] as { maxRetries: number; retryBackoff: string }
    expect(step.maxRetries).toBe(3)
    expect(step.retryBackoff).toBe('exponential')
  })

  test('honors explicit retry options', () => {
    const wf = durable('builder-opts').step('a', async () => 1, {
      maxRetries: 7,
      retryBackoff: 'linear',
    })
    const step = wf.steps[0] as { maxRetries: number; retryBackoff: string }
    expect(step.maxRetries).toBe(7)
    expect(step.retryBackoff).toBe('linear')
  })
})
