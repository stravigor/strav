import { test, expect, describe, beforeAll, beforeEach } from 'bun:test'
import { durable, Durable, WorkflowRun } from '../src/index.ts'
import { boot, clean, drainJobs, getRun, clearJobs } from './helpers.ts'

beforeAll(boot)
beforeEach(clean)

describe('Durable.status', () => {
  test('reports a live snapshot of a run', async () => {
    durable('status-wf')
      .step('a', async () => 1)
      .waitForSignal('gate', 'go')
      .step('b', async () => 2)

    const { runId } = await Durable.start('status-wf', {})
    await drainJobs()

    const snapshot = await Durable.status(runId)
    expect(snapshot.runId).toBe(runId)
    expect(snapshot.workflowName).toBe('status-wf')
    expect(snapshot.status).toBe('suspended')
    expect(snapshot.awaitingSignal).toBe('go')
    expect(snapshot.totalSteps).toBe(3)
    expect(snapshot.results.a).toBe(1)
  })

  test('throws for an unknown run id', async () => {
    await expect(Durable.status(9_999_999)).rejects.toThrow()
  })
})

describe('WorkflowRun model', () => {
  test('the run is a queryable, stateful ORM row', async () => {
    durable('model-wf').step('a', async () => 1)
    const { runId } = await Durable.start('model-wf', {})
    await drainJobs()

    const run = await WorkflowRun.find(runId)
    expect(run).not.toBeNull()
    expect(run!.is('completed')).toBe(true)
    expect(run!.workflowName).toBe('model-wf')
  })
})

describe('Durable.cancel', () => {
  test('cancels a suspended run', async () => {
    durable('cancel-wf').waitForSignal('gate', 'go').step('a', async () => 1)
    const { runId } = await Durable.start('cancel-wf', {})
    await drainJobs()
    expect((await getRun(runId)).status).toBe('suspended')

    await Durable.cancel(runId)
    expect((await getRun(runId)).status).toBe('canceled')

    // A signal to a canceled run is ignored.
    expect((await Durable.resume(runId, 'go', {})).accepted).toBe(false)
  })
})

describe('Durable.recover', () => {
  test('re-enqueues a running run that has lost its job', async () => {
    durable('recover-wf')
      .step('a', async () => 1)
      .step('b', async () => 2)

    const { runId } = await Durable.start('recover-wf', {})
    await drainJobs({ max: 1 }) // run step a; the step-b job is now queued

    await clearJobs() // simulate that job being lost (dead-lettered)
    expect((await getRun(runId)).status).toBe('running')

    const recovered = await Durable.recover()
    expect(recovered).toBe(1)

    await drainJobs()
    expect((await getRun(runId)).status).toBe('completed')
  })
})
