import type {
  AuditEvent,
  AuditQueryOptions,
  AuditRangeOptions,
  AuditStore,
} from '../types.ts'
import { resolveTimeBound } from '../queries.ts'

/**
 * In-memory audit store. For tests and ephemeral environments — events are
 * lost when the process exits. Maintains chain semantics identically to the
 * database driver: assigns monotonic ids, captures `prevHash`, persists `hash`
 * and `createdAt`. Sorting is by id ASC for chronological iteration.
 */
export class MemoryAuditDriver implements AuditStore {
  readonly name = 'memory'
  private events: AuditEvent[] = []
  private nextId = 1

  async ensureTable(): Promise<void> {}

  async insert(event: AuditEvent): Promise<AuditEvent> {
    const stored: AuditEvent = {
      ...event,
      id: this.nextId++,
      prevHash: event.prevHash ?? null,
      hash: event.hash,
      createdAt: event.createdAt ?? new Date(),
    }
    this.events.push(stored)
    return stored
  }

  async lastHash(): Promise<string | null> {
    if (this.events.length === 0) return null
    return this.events[this.events.length - 1]!.hash ?? null
  }

  async forSubject(
    subjectType: string,
    subjectId: string,
    opts?: AuditQueryOptions
  ): Promise<AuditEvent[]> {
    return filterAndSort(
      this.events.filter(e => e.subjectType === subjectType && e.subjectId === subjectId),
      opts
    )
  }

  async forActor(
    actorType: string,
    actorId: string,
    opts?: AuditQueryOptions
  ): Promise<AuditEvent[]> {
    return filterAndSort(
      this.events.filter(e => e.actorType === actorType && e.actorId === actorId),
      opts
    )
  }

  async range(opts: AuditRangeOptions): Promise<AuditEvent[]> {
    return filterAndSort(
      this.events.filter(e => {
        if (opts.subjectType && e.subjectType !== opts.subjectType) return false
        if (opts.subjectId && e.subjectId !== opts.subjectId) return false
        if (opts.actorType && e.actorType !== opts.actorType) return false
        if (opts.actorId && e.actorId !== opts.actorId) return false
        return true
      }),
      opts
    )
  }

  async *walk(opts?: { from?: number; to?: number }): AsyncIterable<AuditEvent> {
    for (const e of this.events) {
      if (opts?.from !== undefined && (e.id ?? 0) < opts.from) continue
      if (opts?.to !== undefined && (e.id ?? 0) > opts.to) continue
      yield e
    }
  }

  async reset(): Promise<void> {
    this.events = []
    this.nextId = 1
  }
}

function filterAndSort(events: AuditEvent[], opts?: AuditQueryOptions): AuditEvent[] {
  let result = events
  if (opts?.actions?.length) {
    const actions = new Set(opts.actions)
    result = result.filter(e => actions.has(e.action))
  }
  if (opts?.since) {
    const since = resolveTimeBound(opts.since)
    result = result.filter(e => (e.createdAt?.getTime() ?? 0) >= since.getTime())
  }
  if (opts?.until) {
    const until = resolveTimeBound(opts.until)
    result = result.filter(e => (e.createdAt?.getTime() ?? 0) <= until.getTime())
  }
  result = result.slice().sort((a, b) => (a.id ?? 0) - (b.id ?? 0))
  if (opts?.limit !== undefined) result = result.slice(0, opts.limit)
  return result
}
