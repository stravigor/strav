/** Diff between two object snapshots, produced by `diff()`. */
export interface AuditDiff {
  added?: Record<string, unknown>
  removed?: Record<string, unknown>
  changed?: Record<string, { before: unknown; after: unknown }>
}

/** A single audit log entry. Stored append-only with an HMAC chain hash. */
export interface AuditEvent {
  /** Monotonic store-assigned identifier. Set on insert. */
  id?: number
  /** Optional — null for system-driven events. */
  actorType?: string
  actorId?: string
  /** Required — what was acted on. */
  subjectType: string
  subjectId: string
  /** Verb describing what happened (`'created'`, `'updated'`, `'qualified'`). */
  action: string
  /** Structured before/after diff. Optional — actions like 'viewed' have nothing to diff. */
  diff?: AuditDiff
  /** Free-form context: request id, ip, user agent, source app, etc. */
  metadata?: Record<string, unknown>
  /** Hash of the previous row in the chain (null for the first row). Set by store. */
  prevHash?: string | null
  /** HMAC-SHA256(prev_hash || canonical_json(event), key). Set by store. */
  hash?: string
  /** Insert timestamp. Set by store. */
  createdAt?: Date
}

/** Anything that can act in an audit event. Either a plain `{type, id}` or any object that exposes the two getters. */
export type AuditActor =
  | { type: string; id: string | number }
  | AuditActorLike

export interface AuditActorLike {
  auditActorType(): string
  auditActorId(): string | number
}

/** Time bounds for queries. Accepts `Date`, ISO string, or `-Nd|h|m` shorthand (e.g. `'-30d'`). */
export type TimeBound = Date | string

export interface AuditQueryOptions {
  since?: TimeBound
  until?: TimeBound
  limit?: number
  actions?: string[]
}

export interface AuditRangeOptions extends AuditQueryOptions {
  subjectType?: string
  subjectId?: string
  actorType?: string
  actorId?: string
}

/**
 * Pluggable storage backend for audit events.
 *
 * Stores must enforce append-only semantics and chain integrity: every
 * insert reads the latest hash, computes the new HMAC, and persists both.
 * Queries must return rows in chronological (id ASC) order so chain
 * verification can walk forward.
 */
export interface AuditStore {
  readonly name: string
  ensureTable(): Promise<void>
  insert(event: AuditEvent): Promise<AuditEvent>
  forSubject(
    subjectType: string,
    subjectId: string,
    opts?: AuditQueryOptions
  ): Promise<AuditEvent[]>
  forActor(
    actorType: string,
    actorId: string,
    opts?: AuditQueryOptions
  ): Promise<AuditEvent[]>
  range(opts: AuditRangeOptions): Promise<AuditEvent[]>
  /**
   * Walk the chain in chronological order. Used by integrity verification.
   * `from` / `to` are inclusive id bounds.
   */
  walk(opts?: { from?: number; to?: number; batchSize?: number }): AsyncIterable<AuditEvent>
  /** Latest stored hash, used as `prevHash` for the next insert. */
  lastHash(): Promise<string | null>
  /** Clear all entries — for tests only. */
  reset(): Promise<void>
}

export interface AuditConfig {
  /** Driver name. Built-ins: 'database', 'memory'. */
  driver: string
  /**
   * If true (default), every insert chains to the previous row via HMAC.
   * Set false only for high-volume non-compliance use cases where the
   * tamper-evidence guarantee isn't needed.
   */
  chain: boolean
}

export interface AuditChainResult {
  ok: boolean
  /** First row id whose hash failed to verify, when ok=false. */
  brokenAt?: number
  checked: number
}
