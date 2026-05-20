import type Stripe from 'stripe'
import { extractUserId } from '@strav/database'
import StripeManager from '../stripe_manager.ts'
import type {
  IdentitySessionCreated,
  IdentitySessionData,
  IdentitySessionStatus,
  IdentitySessionType,
} from '../types.ts'

/**
 * Default document allow-list. Override per call via `options.document.allowed_types`.
 * Covers the three globally-common identity documents.
 */
const DEFAULT_ALLOWED_DOCS: Stripe.Identity.VerificationSessionCreateParams.Options.Document.AllowedType[] =
  ['driving_license', 'passport', 'id_card']

/**
 * Stripe Identity (KYC) verification session management.
 *
 * Wraps `stripe.identity.verificationSessions.*` and keeps a local mirror
 * in `strav_stripe_identity_session`. The mirror is created on
 * {@link createVerificationSession} and updated on each
 * `identity.verification_session.*` webhook (wired in `src/webhook.ts`).
 *
 * Drafitr's A13 (KYC for high-value posts) is the motivating use case;
 * every Strav-based marketplace that needs any KYC gains.
 *
 * @example
 * const session = await StripeIdentity.createVerificationSession(client, {
 *   type: 'document',
 *   returnUrl: 'https://drafitr.com/post-job/identity/complete',
 *   metadata: { purpose: 'high_value_post_v1' },
 * })
 * // → redirect to session.url
 *
 * // Status check
 * const status = await StripeIdentity.getSessionStatus(session.stripeSessionId)
 *
 * // Cancel an in-flight session
 * await StripeIdentity.cancelSession(session.stripeSessionId)
 */
export default class StripeIdentity {
  private static get sql() {
    return StripeManager.db.sql
  }

  private static get fk() {
    return StripeManager.userFkColumn
  }

  /**
   * Create a Stripe Identity verification session and persist a local mirror.
   *
   * Returns the local row plus `url` and `clientSecret` for redirect/embed.
   * Document `allowed_types` defaults to `['driving_license', 'passport', 'id_card']`;
   * override via `options.document.allowed_types`.
   */
  static async createVerificationSession(
    user: unknown,
    params: {
      type?: IdentitySessionType
      returnUrl?: string
      metadata?: Record<string, string>
      options?: Stripe.Identity.VerificationSessionCreateParams.Options
    } = {}
  ): Promise<IdentitySessionCreated> {
    const userId = extractUserId(user)
    const fk = StripeIdentity.fk

    const type = (params.type ?? 'document') as IdentitySessionType
    const stripeParams: Stripe.Identity.VerificationSessionCreateParams = {
      type,
      metadata: { strav_user_id: String(userId), ...(params.metadata ?? {}) },
      ...(params.returnUrl ? { return_url: params.returnUrl } : {}),
      options:
        type === 'document'
          ? {
              document: {
                allowed_types: DEFAULT_ALLOWED_DOCS,
                ...(params.options?.document ?? {}),
              },
              ...(params.options ?? {}),
            }
          : (params.options ?? {}),
    }

    const session = await StripeManager.stripe.identity.verificationSessions.create(stripeParams)

    const metadataJson = params.metadata ? JSON.stringify(params.metadata) : null
    const rows = await StripeIdentity.sql.unsafe(
      `INSERT INTO "strav_stripe_identity_session"
         ("${fk}", "stripe_session_id", "type", "status", "metadata")
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [userId, session.id, type, session.status, metadataJson]
    )
    const local = StripeIdentity.hydrate(rows[0] as Record<string, unknown>)

    return {
      ...local,
      url: session.url ?? '',
      clientSecret: session.client_secret ?? null,
    }
  }

  /**
   * Fetch the current session state from Stripe. Does not touch the local
   * mirror; for that, wait for a webhook or call {@link syncFromStripe}.
   */
  static async getSessionStatus(stripeSessionId: string): Promise<{
    status: IdentitySessionStatus
    documentCountry: string | null
    documentType: string | null
    lastErrorCode: string | null
    lastErrorReason: string | null
  }> {
    const session = await StripeManager.stripe.identity.verificationSessions.retrieve(
      stripeSessionId,
      { expand: ['last_verification_report'] }
    )
    return StripeIdentity.extractStatus(session)
  }

  /** Cancel a pending verification session. */
  static async cancelSession(stripeSessionId: string): Promise<void> {
    await StripeManager.stripe.identity.verificationSessions.cancel(stripeSessionId)
  }

  /**
   * Refresh the local mirror from a Stripe session object (typically from
   * an `identity.verification_session.*` webhook payload).
   */
  static async syncFromStripe(session: Stripe.Identity.VerificationSession): Promise<void> {
    const status = StripeIdentity.extractStatus(session)
    const verifiedAt = session.status === 'verified' ? new Date() : null
    const canceledAt = session.status === 'canceled' ? new Date() : null

    await StripeIdentity.sql`
      UPDATE "strav_stripe_identity_session"
      SET "status" = ${session.status},
          "document_country" = ${status.documentCountry},
          "document_type" = ${status.documentType},
          "last_error_code" = ${status.lastErrorCode},
          "last_error_reason" = ${status.lastErrorReason},
          "verified_at" = COALESCE("verified_at", ${verifiedAt}),
          "canceled_at" = COALESCE("canceled_at", ${canceledAt}),
          "updated_at" = NOW()
      WHERE "stripe_session_id" = ${session.id}
    `
  }

  /**
   * Insert a row from a webhook payload when one doesn't already exist
   * (e.g. session created out-of-band via a dashboard click).
   */
  static async upsertFromStripe(
    user: unknown,
    session: Stripe.Identity.VerificationSession
  ): Promise<void> {
    const existing = await StripeIdentity.findByStripeSessionId(session.id)
    if (existing) {
      await StripeIdentity.syncFromStripe(session)
      return
    }
    const userId = extractUserId(user)
    const fk = StripeIdentity.fk
    await StripeIdentity.sql.unsafe(
      `INSERT INTO "strav_stripe_identity_session"
         ("${fk}", "stripe_session_id", "type", "status", "metadata")
       VALUES ($1, $2, $3, $4, $5)`,
      [
        userId,
        session.id,
        session.type ?? 'document',
        session.status,
        session.metadata ? JSON.stringify(session.metadata) : null,
      ]
    )
  }

  /** List a user's verification sessions, newest first. */
  static async findByUser(user: unknown): Promise<IdentitySessionData[]> {
    const userId = extractUserId(user)
    const fk = StripeIdentity.fk
    const rows = await StripeIdentity.sql.unsafe(
      `SELECT * FROM "strav_stripe_identity_session"
       WHERE "${fk}" = $1
       ORDER BY "created_at" DESC`,
      [userId]
    )
    return rows.map((r: any) => StripeIdentity.hydrate(r))
  }

  /** The most recent verification session for a user (or null). */
  static async latestForUser(user: unknown): Promise<IdentitySessionData | null> {
    const userId = extractUserId(user)
    const fk = StripeIdentity.fk
    const rows = await StripeIdentity.sql.unsafe(
      `SELECT * FROM "strav_stripe_identity_session"
       WHERE "${fk}" = $1
       ORDER BY "created_at" DESC LIMIT 1`,
      [userId]
    )
    return rows.length > 0 ? StripeIdentity.hydrate(rows[0] as Record<string, unknown>) : null
  }

  /** Find a local row by Stripe session id. */
  static async findByStripeSessionId(stripeSessionId: string): Promise<IdentitySessionData | null> {
    const rows = await StripeIdentity.sql`
      SELECT * FROM "strav_stripe_identity_session"
      WHERE "stripe_session_id" = ${stripeSessionId} LIMIT 1
    `
    return rows.length > 0 ? StripeIdentity.hydrate(rows[0] as Record<string, unknown>) : null
  }

  // ---- Internal ----

  private static extractStatus(session: Stripe.Identity.VerificationSession): {
    status: IdentitySessionStatus
    documentCountry: string | null
    documentType: string | null
    lastErrorCode: string | null
    lastErrorReason: string | null
  } {
    const report =
      typeof session.last_verification_report === 'string'
        ? null
        : (session.last_verification_report ?? null)
    const doc = report?.document ?? null

    return {
      status: session.status as IdentitySessionStatus,
      documentCountry: doc?.issuing_country ?? null,
      documentType: doc?.type ?? null,
      lastErrorCode: session.last_error?.code ?? null,
      lastErrorReason: session.last_error?.reason ?? null,
    }
  }

  private static hydrate(row: Record<string, unknown>): IdentitySessionData {
    const fk = StripeIdentity.fk
    return {
      id: row.id as number,
      userId: row[fk] as string | number,
      stripeSessionId: row.stripe_session_id as string,
      type: row.type as IdentitySessionType,
      status: row.status as IdentitySessionStatus,
      documentCountry: (row.document_country as string) ?? null,
      documentType: (row.document_type as string) ?? null,
      lastErrorCode: (row.last_error_code as string) ?? null,
      lastErrorReason: (row.last_error_reason as string) ?? null,
      verifiedAt: (row.verified_at as Date) ?? null,
      canceledAt: (row.canceled_at as Date) ?? null,
      metadata: (row.metadata as Record<string, unknown>) ?? null,
      createdAt: row.created_at as Date,
      updatedAt: row.updated_at as Date,
    }
  }
}
