import { createHash } from 'node:crypto'
import type { SQL } from 'bun'
import type { Middleware } from './middleware.ts'
import type Context from './context.ts'

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** A captured response, persisted under an idempotency key for replay. */
export interface CapturedResponse {
  status: number
  headers: Record<string, string>
  /** Body as base64 (binary-safe for JSON/HTML/binary alike). */
  bodyBase64: string
}

/** A row in the idempotency store. */
export interface IdempotencyRecord {
  key: string
  /** Fingerprint of the original request (method + path + body hash). */
  fingerprint: string
  /** Captured response — `null` while the original request is still in flight. */
  response: CapturedResponse | null
  createdAt: Date
  expiresAt: Date
}

// ---------------------------------------------------------------------------
// Store interface
// ---------------------------------------------------------------------------

/**
 * Pluggable storage for idempotency records.
 *
 * `reserve` is the atomic primitive: it inserts a new record if the key is
 * absent and returns `'inserted'`; otherwise it returns the existing row and
 * `'existing'`. Concurrent callers see exactly one `'inserted'` and the rest
 * `'existing'` — that's what makes the lock race-free.
 */
export interface IdempotencyStore {
  ensureTable?(): Promise<void>
  /** Atomically insert if absent, otherwise return the existing record. */
  reserve(
    key: string,
    fingerprint: string,
    ttlMs: number
  ): Promise<{ status: 'inserted' } | { status: 'existing'; record: IdempotencyRecord }>
  /** Persist the captured response and finalize the record. */
  complete(key: string, response: CapturedResponse): Promise<void>
  /** Remove a record (used to free a key when the handler throws). */
  release(key: string): Promise<void>
  /** Test only. */
  reset?(): Promise<void>
}

// ---------------------------------------------------------------------------
// In-memory store
// ---------------------------------------------------------------------------

/**
 * In-memory idempotency store. Suitable for single-process deployments and
 * tests. Records expire lazily on access.
 */
export class MemoryIdempotencyStore implements IdempotencyStore {
  private records = new Map<string, IdempotencyRecord>()

  async reserve(
    key: string,
    fingerprint: string,
    ttlMs: number
  ): Promise<{ status: 'inserted' } | { status: 'existing'; record: IdempotencyRecord }> {
    const now = new Date()
    const existing = this.records.get(key)
    if (existing && existing.expiresAt > now) {
      return { status: 'existing', record: existing }
    }
    const record: IdempotencyRecord = {
      key,
      fingerprint,
      response: null,
      createdAt: now,
      expiresAt: new Date(now.getTime() + ttlMs),
    }
    this.records.set(key, record)
    return { status: 'inserted' }
  }

  async complete(key: string, response: CapturedResponse): Promise<void> {
    const existing = this.records.get(key)
    if (existing) {
      existing.response = response
    }
  }

  async release(key: string): Promise<void> {
    this.records.delete(key)
  }

  async reset(): Promise<void> {
    this.records.clear()
  }
}

// ---------------------------------------------------------------------------
// Database (PostgreSQL) store
// ---------------------------------------------------------------------------

/**
 * PostgreSQL-backed idempotency store using `_strav_idempotency_keys`.
 *
 * Pass the bun SQL handle in the constructor — typically `Database.raw` from
 * @strav/database. The race-free `reserve` is implemented with
 * `INSERT … ON CONFLICT DO NOTHING RETURNING *`: exactly one concurrent
 * caller observes the inserted row.
 *
 * Expired rows are not auto-cleaned. Run a periodic
 * `DELETE FROM _strav_idempotency_keys WHERE expires_at < NOW()` in a
 * scheduled job (e.g. via @strav/queue's Scheduler).
 */
export class DatabaseIdempotencyStore implements IdempotencyStore {
  constructor(private sql: SQL) {}

  async ensureTable(): Promise<void> {
    await this.sql`
      CREATE TABLE IF NOT EXISTS "_strav_idempotency_keys" (
        "key"             VARCHAR(255) PRIMARY KEY,
        "fingerprint"     TEXT NOT NULL,
        "response_status" INT,
        "response_headers" JSONB,
        "response_body"   TEXT,
        "created_at"      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "expires_at"      TIMESTAMPTZ NOT NULL
      )
    `
    await this.sql`
      CREATE INDEX IF NOT EXISTS "idx_strav_idempotency_keys_expires_at"
        ON "_strav_idempotency_keys" ("expires_at")
    `
  }

  async reserve(
    key: string,
    fingerprint: string,
    ttlMs: number
  ): Promise<{ status: 'inserted' } | { status: 'existing'; record: IdempotencyRecord }> {
    const expiresAt = new Date(Date.now() + ttlMs)
    const inserted = await this.sql`
      INSERT INTO "_strav_idempotency_keys" ("key", "fingerprint", "expires_at")
      VALUES (${key}, ${fingerprint}, ${expiresAt})
      ON CONFLICT ("key") DO NOTHING
      RETURNING *
    `
    if (inserted.length > 0) return { status: 'inserted' }

    const rows = await this.sql`
      SELECT * FROM "_strav_idempotency_keys" WHERE "key" = ${key}
    `
    if (rows.length === 0) {
      // Lost the race AND the conflicting row was deleted between the two
      // queries (extremely unlikely). Retry the insert path.
      return this.reserve(key, fingerprint, ttlMs)
    }
    const row = rows[0] as Record<string, unknown>
    if ((row.expires_at as Date) < new Date()) {
      // Existing record is expired — replace it.
      await this.sql`DELETE FROM "_strav_idempotency_keys" WHERE "key" = ${key}`
      return this.reserve(key, fingerprint, ttlMs)
    }
    return { status: 'existing', record: hydrate(row) }
  }

  async complete(key: string, response: CapturedResponse): Promise<void> {
    await this.sql`
      UPDATE "_strav_idempotency_keys"
      SET "response_status" = ${response.status},
          "response_headers" = ${JSON.stringify(response.headers)}::jsonb,
          "response_body" = ${response.bodyBase64}
      WHERE "key" = ${key}
    `
  }

  async release(key: string): Promise<void> {
    await this.sql`DELETE FROM "_strav_idempotency_keys" WHERE "key" = ${key}`
  }

  async reset(): Promise<void> {
    await this.sql`TRUNCATE TABLE "_strav_idempotency_keys"`
  }
}

function hydrate(row: Record<string, unknown>): IdempotencyRecord {
  const status = row.response_status as number | null
  return {
    key: row.key as string,
    fingerprint: row.fingerprint as string,
    response:
      status !== null
        ? {
            status,
            headers: parseJson<Record<string, string>>(row.response_headers) ?? {},
            bodyBase64: (row.response_body as string | null) ?? '',
          }
        : null,
    createdAt: row.created_at as Date,
    expiresAt: row.expires_at as Date,
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

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

export interface IdempotencyOptions {
  /** TTL in milliseconds for cached responses. Default: 24 hours. */
  ttl?: number
  /** Header name. Default: `Idempotency-Key`. */
  header?: string
  /**
   * HTTP methods this middleware applies to. GET / HEAD / OPTIONS are usually
   * skipped because they're naturally idempotent. Default: POST/PUT/PATCH/DELETE.
   */
  methods?: string[]
  /**
   * If `true`, requests on covered methods that omit the header receive a 400.
   * Default: `false` — missing header just bypasses the middleware.
   */
  required?: boolean
  /** Backing store. Default: in-memory. */
  store?: IdempotencyStore
}

const DEFAULT_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE']
const DEFAULT_TTL = 24 * 60 * 60 * 1000

/**
 * Idempotency-Key middleware.
 *
 * On covered methods, when the request carries a key:
 * 1. The first request with that key runs normally; the response is captured
 *    (status / headers / body) and stored under the key.
 * 2. A subsequent request with the same key and **the same fingerprint**
 *    (method + path + body hash) replays the cached response — the handler
 *    does not run again.
 * 3. A subsequent request with the same key but a **different fingerprint**
 *    receives a `422 Unprocessable Entity` so clients can detect mistakes
 *    rather than silently getting wrong cached data.
 * 4. While the original request is still in flight, concurrent requests with
 *    the same key receive `409 Conflict`.
 *
 * Errored handlers (responses with status >= 500, or thrown exceptions)
 * release the key — clients may retry. 4xx responses ARE cached, since
 * client errors are inherent to the request and should reproduce.
 *
 * @example
 * router.post('/imports', idempotency(), handler)
 *
 * @example
 * router.post('/payments',
 *   idempotency({ store: new DatabaseIdempotencyStore(Database.raw), required: true }),
 *   handler
 * )
 */
export function idempotency(options: IdempotencyOptions = {}): Middleware {
  const ttl = options.ttl ?? DEFAULT_TTL
  const headerName = options.header ?? 'Idempotency-Key'
  const headerLc = headerName.toLowerCase()
  const methods = (options.methods ?? DEFAULT_METHODS).map(m => m.toUpperCase())
  const required = options.required ?? false
  const store = options.store ?? new MemoryIdempotencyStore()

  return async (ctx, next) => {
    if (!methods.includes(ctx.method.toUpperCase())) return next()

    const key = ctx.header(headerLc)
    if (!key) {
      if (required) {
        return jsonResponse(
          400,
          { error: `${headerName} header is required for ${ctx.method} requests` }
        )
      }
      return next()
    }

    const fingerprint = await fingerprintRequest(ctx)
    const reservation = await store.reserve(key, fingerprint, ttl)

    if (reservation.status === 'existing') {
      const { record } = reservation
      if (record.fingerprint !== fingerprint) {
        return jsonResponse(
          422,
          { error: `${headerName} reused with a different request body or path` }
        )
      }
      if (record.response) {
        return rebuildResponse(record.response)
      }
      // Captured response missing → request still in flight elsewhere
      return jsonResponse(409, { error: `${headerName} request still in progress` })
    }

    let response: Response
    try {
      response = await next()
    } catch (err) {
      await store.release(key)
      throw err
    }

    if (response.status >= 500) {
      await store.release(key)
      return response
    }

    const captured = await captureResponse(response)
    await store.complete(key, captured)
    return rebuildResponse(captured)
  }
}

// ---------------------------------------------------------------------------
// Request fingerprinting + response capture
// ---------------------------------------------------------------------------

async function fingerprintRequest(ctx: Context): Promise<string> {
  const method = ctx.method.toUpperCase()
  const path = ctx.url.pathname
  const body = await safelyReadRawBody(ctx)
  const hash = createHash('sha256')
  hash.update(method)
  hash.update('\n')
  hash.update(path)
  hash.update('\n')
  hash.update(body)
  return hash.digest('hex')
}

/**
 * Read the raw body bytes without consuming the parsed body cache. Tries
 * `request.clone()` so downstream handlers can still call `ctx.body()`.
 */
async function safelyReadRawBody(ctx: Context): Promise<Uint8Array> {
  try {
    const clone = ctx.request.clone()
    const buffer = await clone.arrayBuffer()
    return new Uint8Array(buffer)
  } catch {
    return new Uint8Array()
  }
}

async function captureResponse(response: Response): Promise<CapturedResponse> {
  const buffer = await response.clone().arrayBuffer()
  const headers: Record<string, string> = {}
  response.headers.forEach((v, k) => {
    headers[k] = v
  })
  return {
    status: response.status,
    headers,
    bodyBase64: Buffer.from(buffer).toString('base64'),
  }
}

function rebuildResponse(captured: CapturedResponse): Response {
  const body = Buffer.from(captured.bodyBase64, 'base64')
  return new Response(body, {
    status: captured.status,
    headers: { ...captured.headers, 'Idempotent-Replay': 'true' },
  })
}

function jsonResponse(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}
