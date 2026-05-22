import { test, expect, describe, beforeAll, beforeEach } from 'bun:test'
import { workflow } from '@strav/workflow'
import { durable, Durable } from '../src/index.ts'
import { advanceHandler } from '../src/engine/index.ts'
import {
  boot,
  clean,
  clearJobs,
  drainJobs,
  getRun,
  getJournal,
  pendingJobs,
  J,
} from './helpers.ts'

const FAR_FUTURE = () => new Date(Date.now() + 3_600_000)

beforeAll(boot)
beforeEach(clean)

describe('sequential execution', () => {
  test('runs steps in order, chaining results through ctx', async () => {
    const calls: string[] = []
    durable('seq')
      .step('one', async () => {
        calls.push('one')
        return 1
      })
      .step('two', async ctx => {
        calls.push('two')
        return (ctx.results.one as number) + 1
      })
      .step('three', async ctx => {
        calls.push('three')
        return (ctx.results.two as number) + 1
      })

    const { runId } = await Durable.start('seq', { x: 10 })
    await drainJobs()

    const run = await getRun(runId)
    expect(run.status).toBe('completed')
    expect(calls).toEqual(['one', 'two', 'three'])
    expect(J(run.result)).toEqual({ one: 1, two: 2, three: 3 })
  })
})

describe('crash recovery', () => {
  test('resumes from the first incomplete step; completed steps never re-run', async () => {
    const calls: Record<string, number> = {}
    const wf = durable('crash')
    for (let i = 0; i < 6; i++) {
      const name = `s${i}`
      wf.step(name, async () => {
        calls[name] = (calls[name] ?? 0) + 1
        return i
      })
    }

    const { runId } = await Durable.start('crash', {})

    // Simulate a crash after 3 steps.
    await drainJobs({ max: 3 })
    let run = await getRun(runId)
    expect(run.status).toBe('running')
    expect(run.current_step).toBe(3)
    expect((await getJournal(runId)).length).toBe(3)

    // Restart — drain the rest.
    await drainJobs()
    run = await getRun(runId)
    expect(run.status).toBe('completed')

    // Every step ran exactly once across the crash boundary.
    for (let i = 0; i < 6; i++) expect(calls[`s${i}`]).toBe(1)
  })
})

describe('idempotent redelivery', () => {
  test('a stale redelivered advance is a no-op', async () => {
    const calls = { a: 0 }
    durable('idem-seq')
      .step('a', async () => {
        calls.a++
        return 1
      })
      .step('b', async () => 2)

    const { runId } = await Durable.start('idem-seq', {})
    await clearJobs()

    await advanceHandler({ runId, stepIndex: 0, attempt: 1 })
    await advanceHandler({ runId, stepIndex: 0, attempt: 1 }) // redelivery

    expect(calls.a).toBe(1)
    expect((await getJournal(runId)).filter(j => j.step_id === 'a').length).toBe(1)
    expect((await getRun(runId)).current_step).toBe(1)
  })

  test('concurrent duplicate advances journal exactly once', async () => {
    durable('idem-conc')
      .step('a', async () => 1)
      .step('b', async () => 2)

    const { runId } = await Durable.start('idem-conc', {})
    await clearJobs()

    await Promise.all([
      advanceHandler({ runId, stepIndex: 0, attempt: 1 }),
      advanceHandler({ runId, stepIndex: 0, attempt: 1 }),
    ])

    expect((await getJournal(runId)).filter(j => j.step_id === 'a').length).toBe(1)
    expect((await getRun(runId)).current_step).toBe(1)
    expect(await pendingJobs()).toBe(1) // exactly one continuation
  })
})

describe('parallel', () => {
  test('runs entries concurrently, storing each result under its name', async () => {
    durable('par').parallel('p', [
      { name: 'x', handler: async () => 'X' },
      { name: 'y', handler: async () => 'Y' },
      { name: 'z', handler: async () => 'Z' },
    ])

    const { runId } = await Durable.start('par', {})
    await drainJobs()

    const run = await getRun(runId)
    expect(run.status).toBe('completed')
    expect(J(run.result)).toEqual({ x: 'X', y: 'Y', z: 'Z' })

    const journal = await getJournal(runId)
    expect(journal.map(j => j.step_id).sort()).toEqual(['p', 'p#x', 'p#y', 'p#z'])
  })

  test('a crash mid-parallel re-runs only the incomplete entries', async () => {
    const calls: Record<string, number> = {}
    let pass = 0
    durable('par-crash').parallel('p', [
      {
        name: 'x',
        handler: async () => {
          calls.x = (calls.x ?? 0) + 1
          return 'X'
        },
      },
      {
        name: 'y',
        handler: async () => {
          calls.y = (calls.y ?? 0) + 1
          // Fail on the first attempt only.
          if (pass++ === 0) throw new Error('y failed once')
          return 'Y'
        },
      },
    ])

    const { runId } = await Durable.start('par-crash', {})
    await drainJobs({ now: FAR_FUTURE() })

    const run = await getRun(runId)
    expect(run.status).toBe('completed')
    // x succeeded first attempt and was journaled → not re-run on the retry.
    expect(calls.x).toBe(1)
    expect(calls.y).toBe(2)
  })
})

describe('route', () => {
  test('dispatches to the resolved branch', async () => {
    durable('rt').route('r', async ctx => ctx.input.go as string, {
      left: async () => 'went-left',
      right: async () => 'went-right',
    })

    const { runId } = await Durable.start('rt', { go: 'right' })
    await drainJobs()

    expect(J((await getRun(runId)).result).r).toBe('went-right')
  })
})

describe('loop', () => {
  test('iterates until the condition is met', async () => {
    durable('lp').loop('count', async input => (input as number) + 1, {
      maxIterations: 20,
      mapInput: () => 0,
      until: result => (result as number) >= 5,
      feedback: result => result,
    })

    const { runId } = await Durable.start('lp', {})
    await drainJobs()

    const run = await getRun(runId)
    expect(run.status).toBe('completed')
    expect(J(run.result).count).toBe(5)

    const iterRows = (await getJournal(runId)).filter(j =>
      j.step_id.startsWith('count#iter')
    )
    expect(iterRows.length).toBe(5)
  })
})

describe('engine-level retry', () => {
  test('retries a flaky step then succeeds without compensating', async () => {
    let attempts = 0
    durable('retry').step(
      'flaky',
      async ctx => {
        attempts = ctx.attempt
        if (ctx.attempt < 3) throw new Error('boom')
        return 'ok'
      },
      { maxRetries: 3, retryBackoff: 'linear' }
    )

    const { runId } = await Durable.start('retry', {})
    await drainJobs({ now: FAR_FUTURE() })

    const run = await getRun(runId)
    expect(run.status).toBe('completed')
    expect(attempts).toBe(3)
    expect(J(run.result).flaky).toBe('ok')
  })
})

describe('portability', () => {
  test('plain @strav/workflow steps yield identical results under durable', async () => {
    const define = (b: { step: (n: string, h: (ctx: any) => Promise<unknown>) => any }) =>
      b
        .step('a', async () => 1)
        .step('b', async (ctx: any) => (ctx.results.a as number) + 10)

    define(durable('port'))
    const plain = await define(workflow('port-plain')).run({})

    const { runId } = await Durable.start('port', {})
    await drainJobs()

    expect(J((await getRun(runId)).result)).toEqual(plain.results)
  })
})
