import AuditManager from './audit_manager.ts'
import type {
  AuditEvent,
  AuditQueryOptions,
  AuditRangeOptions,
  TimeBound,
} from './types.ts'

/**
 * Convert a `TimeBound` (Date | ISO string | `-Nd|h|m|s` shorthand) to a Date.
 * The shorthand forms are computed relative to `now`. Examples:
 * `'-30d'`, `'-2h'`, `'-15m'`, `'-30s'`.
 */
export function resolveTimeBound(bound: TimeBound, now: Date = new Date()): Date {
  if (bound instanceof Date) return bound
  const trimmed = bound.trim()
  const rel = /^-(\d+)(s|m|h|d)$/.exec(trimmed)
  if (rel) {
    const n = Number(rel[1])
    const unit = rel[2] as 's' | 'm' | 'h' | 'd'
    const unitMs = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[unit]
    return new Date(now.getTime() - n * unitMs)
  }
  const parsed = new Date(trimmed)
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`Invalid TimeBound: ${bound}`)
  }
  return parsed
}

/**
 * Fluent query builder.
 *
 * @example
 * await auditQuery.forSubject('lead', leadId).since('-30d').all()
 * await auditQuery.forActor('user', userId).actions(['updated', 'deleted']).limit(50).all()
 * await auditQuery.range({ subjectType: 'lead' }).since('-7d').all()
 */
class PendingAuditQuery {
  constructor(private base: { kind: 'subject' | 'actor' | 'range'; opts: AuditRangeOptions }) {}

  since(bound: TimeBound): this {
    this.base.opts.since = bound
    return this
  }

  until(bound: TimeBound): this {
    this.base.opts.until = bound
    return this
  }

  actions(list: string[]): this {
    this.base.opts.actions = list
    return this
  }

  limit(n: number): this {
    this.base.opts.limit = n
    return this
  }

  async all(): Promise<AuditEvent[]> {
    const opts: AuditQueryOptions = {
      since: this.base.opts.since,
      until: this.base.opts.until,
      limit: this.base.opts.limit,
      actions: this.base.opts.actions,
    }
    if (this.base.kind === 'subject') {
      return AuditManager.store.forSubject(
        this.base.opts.subjectType!,
        this.base.opts.subjectId!,
        opts
      )
    }
    if (this.base.kind === 'actor') {
      return AuditManager.store.forActor(
        this.base.opts.actorType!,
        this.base.opts.actorId!,
        opts
      )
    }
    return AuditManager.store.range(this.base.opts)
  }
}

export const auditQuery = {
  forSubject(subjectType: string, subjectId: string | number): PendingAuditQuery {
    return new PendingAuditQuery({
      kind: 'subject',
      opts: { subjectType, subjectId: String(subjectId) },
    })
  },
  forActor(actorType: string, actorId: string | number): PendingAuditQuery {
    return new PendingAuditQuery({
      kind: 'actor',
      opts: { actorType, actorId: String(actorId) },
    })
  },
  range(filter: Omit<AuditRangeOptions, 'since' | 'until' | 'limit' | 'actions'>): PendingAuditQuery {
    return new PendingAuditQuery({ kind: 'range', opts: { ...filter } })
  },
}
