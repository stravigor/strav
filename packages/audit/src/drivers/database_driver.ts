import type { SQL } from 'bun'
import type {
  AuditEvent,
  AuditQueryOptions,
  AuditRangeOptions,
  AuditStore,
} from '../types.ts'
import { resolveTimeBound } from '../queries.ts'

/**
 * PostgreSQL-backed append-only audit store using `_strav_audit_log`.
 *
 * The chain hash is stored as TEXT (hex). BIGSERIAL ids guarantee monotonic
 * ordering for chain walking; queries always sort by id ASC so verification
 * can replay the chain forward.
 */
export class DatabaseAuditDriver implements AuditStore {
  readonly name = 'database'

  constructor(private sql: SQL) {}

  async ensureTable(): Promise<void> {
    await this.sql`
      CREATE TABLE IF NOT EXISTS "_strav_audit_log" (
        "id"           BIGSERIAL PRIMARY KEY,
        "actor_type"   VARCHAR(255),
        "actor_id"     VARCHAR(255),
        "subject_type" VARCHAR(255) NOT NULL,
        "subject_id"   VARCHAR(255) NOT NULL,
        "action"       VARCHAR(64)  NOT NULL,
        "diff"         JSONB,
        "metadata"     JSONB,
        "prev_hash"    TEXT,
        "hash"         TEXT,
        "created_at"   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `
    await this.sql`
      CREATE INDEX IF NOT EXISTS "idx_strav_audit_log_subject"
        ON "_strav_audit_log" ("subject_type", "subject_id", "id" DESC)
    `
    await this.sql`
      CREATE INDEX IF NOT EXISTS "idx_strav_audit_log_actor"
        ON "_strav_audit_log" ("actor_type", "actor_id", "id" DESC)
        WHERE "actor_type" IS NOT NULL
    `
    await this.sql`
      CREATE INDEX IF NOT EXISTS "idx_strav_audit_log_created_at"
        ON "_strav_audit_log" ("created_at" DESC)
    `
  }

  async insert(event: AuditEvent): Promise<AuditEvent> {
    const diffJson = event.diff ? JSON.stringify(event.diff) : null
    const metaJson = event.metadata ? JSON.stringify(event.metadata) : null
    const rows = await this.sql`
      INSERT INTO "_strav_audit_log"
        ("actor_type", "actor_id", "subject_type", "subject_id", "action",
         "diff", "metadata", "prev_hash", "hash")
      VALUES
        (${event.actorType ?? null}, ${event.actorId ?? null},
         ${event.subjectType}, ${event.subjectId}, ${event.action},
         ${diffJson}::jsonb, ${metaJson}::jsonb,
         ${event.prevHash ?? null}, ${event.hash ?? null})
      RETURNING "id", "created_at"
    `
    const row = rows[0] as Record<string, unknown>
    return {
      ...event,
      id: Number(row.id),
      createdAt: row.created_at as Date,
    }
  }

  async lastHash(): Promise<string | null> {
    const rows = await this.sql`
      SELECT "hash" FROM "_strav_audit_log" ORDER BY "id" DESC LIMIT 1
    `
    if (rows.length === 0) return null
    return ((rows[0] as Record<string, unknown>).hash as string | null) ?? null
  }

  async forSubject(
    subjectType: string,
    subjectId: string,
    opts?: AuditQueryOptions
  ): Promise<AuditEvent[]> {
    const where = buildWhere(opts, [
      this.sql`"subject_type" = ${subjectType}`,
      this.sql`"subject_id" = ${subjectId}`,
    ], this.sql)
    const rows = await this.sql`
      SELECT * FROM "_strav_audit_log"
      ${where}
      ORDER BY "id" ASC
      ${limitClause(opts?.limit, this.sql)}
    `
    return rows.map(hydrate)
  }

  async forActor(
    actorType: string,
    actorId: string,
    opts?: AuditQueryOptions
  ): Promise<AuditEvent[]> {
    const where = buildWhere(opts, [
      this.sql`"actor_type" = ${actorType}`,
      this.sql`"actor_id" = ${actorId}`,
    ], this.sql)
    const rows = await this.sql`
      SELECT * FROM "_strav_audit_log"
      ${where}
      ORDER BY "id" ASC
      ${limitClause(opts?.limit, this.sql)}
    `
    return rows.map(hydrate)
  }

  async range(opts: AuditRangeOptions): Promise<AuditEvent[]> {
    const conditions = []
    if (opts.subjectType) conditions.push(this.sql`"subject_type" = ${opts.subjectType}`)
    if (opts.subjectId) conditions.push(this.sql`"subject_id" = ${opts.subjectId}`)
    if (opts.actorType) conditions.push(this.sql`"actor_type" = ${opts.actorType}`)
    if (opts.actorId) conditions.push(this.sql`"actor_id" = ${opts.actorId}`)
    const where = buildWhere(opts, conditions, this.sql)
    const rows = await this.sql`
      SELECT * FROM "_strav_audit_log"
      ${where}
      ORDER BY "id" ASC
      ${limitClause(opts.limit, this.sql)}
    `
    return rows.map(hydrate)
  }

  async *walk(opts?: { from?: number; to?: number; batchSize?: number }): AsyncIterable<AuditEvent> {
    const batchSize = opts?.batchSize ?? 1000
    let cursor = opts?.from ?? 0
    const max = opts?.to
    while (true) {
      const rows = await this.sql`
        SELECT * FROM "_strav_audit_log"
        WHERE "id" >= ${cursor}
          ${max !== undefined ? this.sql`AND "id" <= ${max}` : this.sql``}
        ORDER BY "id" ASC
        LIMIT ${batchSize}
      `
      if (rows.length === 0) return
      for (const row of rows) yield hydrate(row as Record<string, unknown>)
      cursor = Number((rows[rows.length - 1] as Record<string, unknown>).id) + 1
      if (rows.length < batchSize) return
    }
  }

  async reset(): Promise<void> {
    await this.sql`TRUNCATE TABLE "_strav_audit_log" RESTART IDENTITY`
  }
}

function hydrate(row: Record<string, unknown>): AuditEvent {
  return {
    id: row.id !== undefined ? Number(row.id) : undefined,
    actorType: (row.actor_type as string | null) ?? undefined,
    actorId: (row.actor_id as string | null) ?? undefined,
    subjectType: row.subject_type as string,
    subjectId: row.subject_id as string,
    action: row.action as string,
    diff: parseJson(row.diff),
    metadata: parseJson(row.metadata),
    prevHash: (row.prev_hash as string | null) ?? null,
    hash: (row.hash as string | null) ?? undefined,
    createdAt: row.created_at as Date,
  }
}

function parseJson<T>(raw: unknown): T | undefined {
  if (raw === null || raw === undefined) return undefined
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as T
    } catch {
      return undefined
    }
  }
  return raw as T
}

function buildWhere(
  opts: AuditQueryOptions | undefined,
  base: unknown[],
  sql: SQL
): unknown {
  const all = [...base]
  if (opts?.actions?.length) {
    all.push(sql`"action" = ANY(${opts.actions})`)
  }
  if (opts?.since) {
    all.push(sql`"created_at" >= ${resolveTimeBound(opts.since)}`)
  }
  if (opts?.until) {
    all.push(sql`"created_at" <= ${resolveTimeBound(opts.until)}`)
  }
  if (all.length === 0) return sql``
  let acc = sql`WHERE ${all[0]}`
  for (let i = 1; i < all.length; i++) acc = sql`${acc} AND ${all[i]}`
  return acc
}

function limitClause(limit: number | undefined, sql: SQL): unknown {
  return limit !== undefined ? sql`LIMIT ${limit}` : sql``
}
