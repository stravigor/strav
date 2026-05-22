import { test, expect, describe, beforeAll, beforeEach } from 'bun:test'
import { sql } from '@strav/database'
import { durable, Durable } from '../src/index.ts'
import { boot, clean, drainJobs, getRun, getJournal, J } from './helpers.ts'

const FAR_FUTURE = () => new Date(Date.now() + 3_600_000)

beforeAll(boot)
beforeEach(clean)

describe('child workflows', () => {
  test('spawns an independently durable child and fans its result back in', async () => {
    durable('child-wf').step('double', async ctx => ({
      doubled: (ctx.input.n as number) * 2,
    }))

    durable('parent-wf')
      .step('prep', async () => 'ready')
      .childWorkflow('sub', 'child-wf', () => ({ n: 21 }))
      .step('final', async ctx => ({ fromChild: ctx.results.sub }))

    const { runId } = await Durable.start('parent-wf', {})
    await drainJobs()

    const run = await getRun(runId)
    expect(run.status).toBe('completed')

    const children = (await sql`
      SELECT * FROM "_strav_workflow_runs" WHERE "parent_run_id" = ${runId}
    `) as any[]
    expect(children.length).toBe(1)
    expect(children[0].status).toBe('completed')
    expect(children[0].parent_step_id).toBe('sub')

    const result = J(run.result)
    expect(result.final.fromChild.double).toEqual({ doubled: 42 })
  })

  test('a failing child rolls the parent back', async () => {
    durable('bad-child').step('boom', async () => {
      throw new Error('child exploded')
    }, { maxRetries: 1 })

    const rolledBack: string[] = []
    durable('parent-of-bad')
      .step('setup', async () => 'done', {
        compensate: async () => {
          rolledBack.push('setup')
        },
      })
      .childWorkflow('sub', 'bad-child')
      .step('never', async () => 'unreachable')

    const { runId } = await Durable.start('parent-of-bad', {})
    await drainJobs({ now: FAR_FUTURE() })

    const run = await getRun(runId)
    expect(run.status).toBe('failed')
    expect(rolledBack).toEqual(['setup'])
  })
})

describe('saga compensation', () => {
  test('runs compensators in reverse order and journals each', async () => {
    const comp: string[] = []
    durable('saga')
      .step('reserve', async () => 'reserved', {
        compensate: async () => {
          comp.push('reserve')
        },
      })
      .step('charge', async () => 'charged', {
        compensate: async () => {
          comp.push('charge')
        },
      })
      .step('ship', async () => {
        throw new Error('ship failed')
      }, { maxRetries: 1 })

    const { runId } = await Durable.start('saga', {})
    await drainJobs({ now: FAR_FUTURE() })

    const run = await getRun(runId)
    expect(run.status).toBe('failed')
    expect(run.error).toContain('ship failed')
    expect(comp).toEqual(['charge', 'reserve']) // reverse of completion order

    const journal = await getJournal(runId)
    const compRows = journal.filter(j => j.step_id.endsWith('#compensate'))
    expect(compRows.map(j => j.step_id).sort()).toEqual([
      'charge#compensate',
      'reserve#compensate',
    ])
  })

  test('compensation resumes crash-safely without double-running a compensator', async () => {
    const comp: string[] = []
    durable('saga-crash')
      .step('a', async () => 1, {
        compensate: async () => {
          comp.push('a')
        },
      })
      .step('b', async () => 2, {
        compensate: async () => {
          comp.push('b')
        },
      })
      .step('c', async () => {
        throw new Error('c failed')
      }, { maxRetries: 1 })

    const { runId } = await Durable.start('saga-crash', {})

    // Process: a, b, c(fail → compensating), compensate(b) — then "crash".
    await drainJobs({ max: 4, now: FAR_FUTURE() })
    expect((await getRun(runId)).status).toBe('compensating')
    expect(comp).toEqual(['b'])

    // Resume — finishes the rollback; b is not compensated twice.
    await drainJobs({ now: FAR_FUTURE() })
    expect((await getRun(runId)).status).toBe('failed')
    expect(comp).toEqual(['b', 'a'])
  })
})
