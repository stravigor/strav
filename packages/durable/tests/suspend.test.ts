import { test, expect, describe, beforeAll, beforeEach } from 'bun:test'
import { durable, Durable } from '../src/index.ts'
import { boot, clean, drainJobs, getRun, pendingJobs, J } from './helpers.ts'

beforeAll(boot)
beforeEach(clean)

describe('waitForSignal', () => {
  test('suspends with no process, then resumes exactly on the signal', async () => {
    durable('approval')
      .step('prepare', async () => 'prepared')
      .waitForSignal('gate', 'manager-approval')
      .step('finish', async ctx => ({ approved: ctx.results.gate }))

    const { runId } = await Durable.start('approval', {})
    await drainJobs()

    let run = await getRun(runId)
    expect(run.status).toBe('suspended')
    expect(run.awaiting_signal).toBe('manager-approval')
    expect(run.current_step).toBe(1) // parked on the signal step
    expect(await pendingJobs()).toBe(0) // holds no job while suspended

    // A mismatched signal is rejected without disturbing the run.
    const wrong = await Durable.resume(runId, 'some-other-signal', {})
    expect(wrong.accepted).toBe(false)
    expect((await getRun(runId)).status).toBe('suspended')

    // The matching signal resumes it.
    const ok = await Durable.resume(runId, 'manager-approval', { ok: true })
    expect(ok.accepted).toBe(true)

    await drainJobs()
    run = await getRun(runId)
    expect(run.status).toBe('completed')
    expect(J(run.result).finish).toEqual({ approved: { ok: true } })
  })

  test('a duplicate resume after completion is an idempotent no-op', async () => {
    durable('approval-dup').waitForSignal('gate', 'go').step('done', async () => 1)

    const { runId } = await Durable.start('approval-dup', {})
    await drainJobs()

    expect((await Durable.resume(runId, 'go', {})).accepted).toBe(true)
    await drainJobs()
    expect((await getRun(runId)).status).toBe('completed')

    const dup = await Durable.resume(runId, 'go', {})
    expect(dup.accepted).toBe(false)
  })
})

describe('durable sleep', () => {
  test('suspends across the timer and resumes when it elapses', async () => {
    durable('sleeper')
      .step('before', async () => 'b')
      .sleep('nap', 60_000)
      .step('after', async () => 'a')

    const { runId } = await Durable.start('sleeper', {})

    // A plain drain stops at the sleep — its continuation is not yet due.
    await drainJobs()
    let run = await getRun(runId)
    expect(run.status).toBe('running')
    expect(run.current_step).toBe(2) // past 'before' and 'nap'
    expect(run.wake_at).not.toBeNull()
    expect(await pendingJobs()).toBe(1) // the delayed continuation

    // Advance the clock past the timer.
    await drainJobs({ now: new Date(Date.now() + 61_000) })
    run = await getRun(runId)
    expect(run.status).toBe('completed')
  })
})

describe('brain agent composition', () => {
  test('a step returning a SuspendedRun suspends the run; resume re-enters it', async () => {
    durable('agent').step('think', async ctx => {
      const prior = ctx.signal('think')
      if (!prior) {
        // First pass — the agent suspended on a tool call.
        return { status: 'suspended', pendingToolCalls: [{ id: 't1' }], state: { round: 1 } }
      }
      // Resumed — finish with the delivered tool results.
      return { answer: 'done', resumeWas: ctx.resumeData() }
    })

    const { runId } = await Durable.start('agent', {})
    await drainJobs()

    let run = await getRun(runId)
    expect(run.status).toBe('suspended')
    expect(run.awaiting_signal).toBe('think')

    const resumed = await Durable.resume(runId, 'think', { toolResult: 42 })
    expect(resumed.accepted).toBe(true)

    await drainJobs()
    run = await getRun(runId)
    expect(run.status).toBe('completed')
    expect(J(run.result).think).toEqual({
      answer: 'done',
      resumeWas: { toolResult: 42 },
    })
  })
})
