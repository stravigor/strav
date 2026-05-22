import { Container } from '@strav/kernel/core'
import Configuration from '@strav/kernel/config/configuration'
import Database from '@strav/database/database/database'
import { sql } from '@strav/database'
import { BaseModel } from '@strav/database'
import { Queue } from '@strav/queue'
import { Durable } from '../src/durable.ts'
import { advanceHandler, compensateHandler } from '../src/engine/index.ts'

let booted = false
let db: Database

/** Boot a real Database + Queue against the testing Postgres and the engine. */
export async function boot(): Promise<void> {
  if (booted) return

  const container = new Container()
  const config = new Configuration({})
  config.set('database.host', '127.0.0.1')
  config.set('database.port', 5432)
  config.set('database.username', 'liva')
  config.set('database.password', 'password1234')
  config.set('database.database', 'strav_testing')

  container.singleton(Configuration, () => config)
  container.singleton(Database)

  db = container.resolve(Database)
  await db.init()

  new BaseModel(db)
  new Queue(db, config)

  await Queue.ensureTables()
  await Durable.ensureTables()
  Durable.registerHandlers()

  booted = true
}

/** Truncate every engine + queue table between tests. */
export async function clean(): Promise<void> {
  await sql`DELETE FROM "_strav_workflow_journal"`
  await sql`DELETE FROM "_strav_workflow_runs"`
  await sql`DELETE FROM "_strav_jobs"`
  await sql`DELETE FROM "_strav_failed_jobs"`
}

/**
 * Simulate a `@strav/queue` worker: pick up due `durable:*` jobs and dispatch
 * them to the engine handlers, one at a time, until the queue drains.
 *
 * With no `now`, "current time" is re-read each iteration — so the drain
 * naturally stops at a durable `sleep` (its delayed continuation is not yet
 * due). Pass a future `now` to drive past sleeps / retry backoff.
 *
 * @param opts.now  fixed "current time" — jobs whose `available_at` is later
 *                  than this are left untouched.
 * @param opts.max  stop after processing this many jobs (simulate a crash).
 */
export async function drainJobs(opts?: { now?: Date; max?: number }): Promise<number> {
  const fixedNow = opts?.now
  const max = opts?.max ?? 10_000
  let processed = 0

  while (processed < max) {
    const now = fixedNow ?? new Date()
    const rows = (await sql`
      SELECT * FROM "_strav_jobs"
      WHERE "job" IN ('durable:advance', 'durable:compensate')
        AND "available_at" <= ${now}
        AND "reserved_at" IS NULL
      ORDER BY "id" ASC
      LIMIT 1
    `) as any[]
    if (rows.length === 0) break

    const job = rows[0]
    await sql`DELETE FROM "_strav_jobs" WHERE "id" = ${job.id}`
    const payload =
      typeof job.payload === 'string' ? JSON.parse(job.payload) : job.payload

    if (job.job === 'durable:advance') await advanceHandler(payload)
    else await compensateHandler(payload)

    processed++
  }
  return processed
}

/** The raw `_strav_workflow_runs` row for a run. */
export async function getRun(runId: number): Promise<any> {
  const rows = (await sql`
    SELECT * FROM "_strav_workflow_runs" WHERE "id" = ${runId}
  `) as any[]
  return rows[0]
}

/** All journal rows for a run, ordered by id. */
export async function getJournal(runId: number): Promise<any[]> {
  return (await sql`
    SELECT * FROM "_strav_workflow_journal"
    WHERE "run_id" = ${runId} ORDER BY "id"
  `) as any[]
}

/** Delete every queued job (used to isolate manually-driven handler calls). */
export async function clearJobs(): Promise<void> {
  await sql`DELETE FROM "_strav_jobs"`
}

/** Normalize a JSONB column value (object or raw string) to an object. */
export function J(value: unknown): any {
  return typeof value === 'string' ? JSON.parse(value) : value
}

/** Count of pending durable jobs in the queue. */
export async function pendingJobs(): Promise<number> {
  const rows = (await sql`
    SELECT COUNT(*)::int AS c FROM "_strav_jobs"
    WHERE "job" IN ('durable:advance', 'durable:compensate')
  `) as any[]
  return rows[0].c as number
}
