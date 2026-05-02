import AuditManager from './audit_manager.ts'
import { diff as computeDiff } from './diff.ts'
import { verifyChain } from './integrity.ts'
import type { AuditActor, AuditDiff, AuditEvent } from './types.ts'

function resolveActor(actor: AuditActor): { type: string; id: string } {
  if ('type' in actor && 'id' in actor) {
    return { type: actor.type, id: String(actor.id) }
  }
  return { type: actor.auditActorType(), id: String(actor.auditActorId()) }
}

/**
 * Fluent audit-event builder. Returned by `audit.by(...)`.
 *
 * @example
 * await audit
 *   .by({ type: 'user', id: user.id })
 *   .on('lead', leadId)
 *   .action('qualified')
 *   .diff(oldLead, newLead)
 *   .meta({ requestId, ip })
 *   .log()
 */
export class PendingAuditEvent {
  private _actorType?: string
  private _actorId?: string
  private _subjectType?: string
  private _subjectId?: string
  private _action?: string
  private _diff?: AuditDiff
  private _metadata?: Record<string, unknown>

  /** Set actor. Pass either `{type, id}` or any object exposing audit-actor getters. */
  by(actor: AuditActor): this {
    const { type, id } = resolveActor(actor)
    this._actorType = type
    this._actorId = id
    return this
  }

  /** Subject (what was acted on). */
  on(subjectType: string, subjectId: string | number): this {
    this._subjectType = subjectType
    this._subjectId = String(subjectId)
    return this
  }

  /** Verb describing what happened. */
  action(verb: string): this {
    this._action = verb
    return this
  }

  /**
   * Compute and attach a structural diff between two snapshots. Either pass a
   * pre-built `AuditDiff` or two snapshots (`before`, `after`).
   */
  diff(before: unknown, after?: unknown): this {
    if (after === undefined && before && typeof before === 'object' && !Array.isArray(before)) {
      const obj = before as AuditDiff
      if ('added' in obj || 'removed' in obj || 'changed' in obj) {
        this._diff = obj
        return this
      }
    }
    this._diff = computeDiff(before, after)
    return this
  }

  /** Free-form context metadata. */
  meta(data: Record<string, unknown>): this {
    this._metadata = { ...(this._metadata ?? {}), ...data }
    return this
  }

  build(): AuditEvent {
    if (!this._subjectType || !this._subjectId) {
      throw new Error('audit: .on(subjectType, subjectId) is required before .log()')
    }
    if (!this._action) {
      throw new Error('audit: .action(verb) is required before .log()')
    }
    return {
      actorType: this._actorType,
      actorId: this._actorId,
      subjectType: this._subjectType,
      subjectId: this._subjectId,
      action: this._action,
      diff: this._diff,
      metadata: this._metadata,
    }
  }

  async log(): Promise<AuditEvent> {
    return AuditManager.append(this.build())
  }
}

/**
 * Audit helper — primary append API.
 *
 * @example
 * import { audit } from '@strav/audit'
 *
 * await audit.by(user).on('lead', leadId).action('updated').diff(before, after).log()
 *
 * // Direct write without the fluent builder
 * await audit.write({ subjectType: 'lead', subjectId: leadId, action: 'viewed' })
 *
 * // Verify integrity (cron / on-demand)
 * const result = await audit.verifyChain()
 */
export const audit = {
  by(actor: AuditActor): PendingAuditEvent {
    return new PendingAuditEvent().by(actor)
  },
  on(subjectType: string, subjectId: string | number): PendingAuditEvent {
    return new PendingAuditEvent().on(subjectType, subjectId)
  },
  /** Append a fully-formed event without the fluent builder. */
  async write(event: AuditEvent): Promise<AuditEvent> {
    return AuditManager.append(event)
  },
  verifyChain,
}
