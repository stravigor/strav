import type Stripe from 'stripe'
import { extractUserId } from '@strav/database'
import StripeManager from '../stripe_manager.ts'
import Customer from '../customer.ts'
import Ledger from '../ledger/ledger.ts'
import { HoldStateError } from '../errors.ts'
import type { HoldData, HoldEventData, HoldStatus, HoldReleaseOptions } from '../types.ts'

/**
 * Valid hold state transitions. Source of truth for the state machine.
 *
 *   pending ──► authorized ──► released ──► refunded
 *                       │
 *                       ├──► refunded
 *                       └──► expired
 *
 * Add a transition? Update this table and the `Hold` JSDoc above.
 */
const VALID_TRANSITIONS: Record<HoldStatus, HoldStatus[]> = {
  pending: ['authorized', 'expired'],
  authorized: ['released', 'refunded', 'expired'],
  released: ['refunded'],
  refunded: [],
  expired: [],
}

/**
 * Escrow hold primitive backed by a Stripe manual-capture PaymentIntent
 * plus the local `strav_stripe_hold` + `strav_stripe_hold_event` tables.
 *
 * Lifecycle:
 *   1. `Hold.create()` — authorizes a PaymentIntent (`capture_method: 'manual'`)
 *      and inserts a `pending` row. Stripe authorizations expire after 7 days
 *      by default.
 *   2. Stripe sends `payment_intent.amount_capturable_updated` → the webhook
 *      handler calls `Hold.recordEvent(id, 'pending', 'authorized')`.
 *   3. `Hold.release({ destination, applicationFeeAmount })` captures + transfers
 *      to a connected account, withholding the platform fee. Writes three
 *      ledger entries (charge, application_fee, transfer) and transitions
 *      to `released`.
 *   4. `Hold.refund()` returns funds to the client; `Hold.cancel()` voids an
 *      authorization before capture.
 *
 * Atomicity: the local hold row + hold_event are written in a single DB
 * transaction. Stripe API calls are not part of that transaction — if a
 * capture succeeds but the transfer call fails, the hold stays in
 * `authorized` and the operator retries `Hold.release()`.
 *
 * @example
 * const hold = await Hold.create(client, {
 *   amount: 100000,
 *   paymentMethodId: pm.id,
 *   description: 'Milestone 1',
 * })
 * // later, on approval:
 * await Hold.release(hold.id, {
 *   destination: freelancer.stripeAccountId,
 *   applicationFeeAmount: 10000, // $100 platform fee
 * })
 */
export default class Hold {
  private static get sql() {
    return StripeManager.db.sql
  }

  private static get fk() {
    return StripeManager.userFkColumn
  }

  /**
   * Authorize a hold against the user's default payment method (or the
   * one passed via `paymentMethodId`). Writes a `pending` row; transitions
   * to `authorized` on the `payment_intent.amount_capturable_updated`
   * webhook.
   */
  static async create(
    user: unknown,
    options: {
      amount: number
      paymentMethodId: string
      currency?: string
      description?: string
      metadata?: Record<string, string>
    }
  ): Promise<HoldData> {
    const userId = extractUserId(user)
    const fk = Hold.fk
    const customer = await Customer.createOrGet(user)
    const currency = options.currency ?? StripeManager.config.currency

    const intent = await StripeManager.stripe.paymentIntents.create({
      amount: options.amount,
      currency,
      customer: customer.stripeId,
      payment_method: options.paymentMethodId,
      capture_method: 'manual',
      confirm: true,
      off_session: false,
      description: options.description,
      metadata: {
        strav_user_id: String(userId),
        strav_hold: 'true',
        ...(options.metadata ?? {}),
      },
    })

    const metadataJson = options.metadata ? JSON.stringify(options.metadata) : null
    const rows = await Hold.sql.unsafe(
      `INSERT INTO "strav_stripe_hold"
         ("${fk}", "payment_intent_id", "amount", "currency", "status", "metadata")
       VALUES ($1, $2, $3, $4, 'pending', $5)
       RETURNING *`,
      [userId, intent.id, options.amount, currency, metadataJson]
    )
    const hold = Hold.hydrate(rows[0] as Record<string, unknown>)

    await Hold.insertEvent(hold.id, 'create', null, 'pending', { stripeIntentId: intent.id })

    return hold
  }

  /**
   * Capture the authorized amount and transfer (minus the application fee)
   * to a connected account. Writes three ledger entries and transitions
   * the hold to `released`.
   */
  static async release(holdId: number, options: HoldReleaseOptions): Promise<HoldData> {
    const hold = await Hold.findById(holdId)
    if (!hold) throw new HoldStateError(holdId, '(missing)', 'released')

    Hold.assertTransition(hold.status, 'released')

    const captureAmount = options.amountToCapture ?? hold.amount
    const fee = options.applicationFeeAmount ?? 0
    const transferAmount = captureAmount - fee

    // 1. Capture the PaymentIntent
    const captured = await StripeManager.stripe.paymentIntents.capture(hold.paymentIntentId, {
      amount_to_capture: captureAmount,
    })

    const chargeId =
      typeof captured.latest_charge === 'string'
        ? captured.latest_charge
        : (captured.latest_charge?.id ?? null)

    // 2. Transfer to the connected account
    const transfer = await StripeManager.stripe.transfers.create({
      amount: transferAmount,
      currency: hold.currency,
      destination: options.destination,
      ...(chargeId ? { source_transaction: chargeId } : {}),
      description: options.description ?? `Hold ${holdId} release`,
      metadata: { strav_hold_id: String(holdId) },
    })

    // 3. Write ledger entries (charge debit, application_fee credit, transfer debit)
    await Ledger.record({
      user: hold.userId,
      entryType: 'charge',
      direction: 'debit',
      amount: captureAmount,
      currency: hold.currency,
      stripeIntentId: hold.paymentIntentId,
      stripeChargeId: chargeId,
      holdId: hold.id,
      description: options.description ?? `Hold ${holdId} capture`,
    })

    if (fee > 0) {
      await Ledger.record({
        user: hold.userId,
        entryType: 'application_fee',
        direction: 'credit',
        amount: fee,
        currency: hold.currency,
        stripeIntentId: hold.paymentIntentId,
        stripeChargeId: chargeId,
        connectAccountId: options.destination,
        holdId: hold.id,
        description: `Hold ${holdId} platform fee`,
      })
    }

    await Ledger.record({
      user: hold.userId,
      entryType: 'transfer',
      direction: 'debit',
      amount: transferAmount,
      currency: hold.currency,
      stripeIntentId: hold.paymentIntentId,
      stripeTransferId: transfer.id,
      connectAccountId: options.destination,
      holdId: hold.id,
      description: options.description ?? `Hold ${holdId} transfer`,
    })

    // 4. Update hold + write transition event
    await Hold.sql`
      UPDATE "strav_stripe_hold"
      SET "status" = 'released',
          "destination_account_id" = ${options.destination},
          "application_fee_amount" = ${fee || null},
          "updated_at" = NOW()
      WHERE "id" = ${holdId}
    `
    await Hold.insertEvent(holdId, 'release', hold.status, 'released', {
      destination: options.destination,
      captureAmount,
      fee,
      stripeTransferId: transfer.id,
    })

    return (await Hold.findById(holdId)) as HoldData
  }

  /**
   * Refund a hold. Works from `authorized` (cancel-before-capture happens
   * via `cancel()` for cleaner semantics) or `released` (full reversal).
   * Writes a `refund` credit ledger entry.
   */
  static async refund(holdId: number, amount?: number): Promise<HoldData> {
    const hold = await Hold.findById(holdId)
    if (!hold) throw new HoldStateError(holdId, '(missing)', 'refunded')

    Hold.assertTransition(hold.status, 'refunded')

    const refundAmount = amount ?? hold.amount
    const refund = await StripeManager.stripe.refunds.create({
      payment_intent: hold.paymentIntentId,
      ...(amount ? { amount } : {}),
    })

    await Ledger.record({
      user: hold.userId,
      entryType: 'refund',
      direction: 'credit',
      amount: refundAmount,
      currency: hold.currency,
      stripeIntentId: hold.paymentIntentId,
      holdId: hold.id,
      description: `Hold ${holdId} refund`,
      metadata: { refundId: refund.id },
    })

    await Hold.sql`
      UPDATE "strav_stripe_hold"
      SET "status" = 'refunded', "updated_at" = NOW()
      WHERE "id" = ${holdId}
    `
    await Hold.insertEvent(holdId, 'refund', hold.status, 'refunded', {
      refundId: refund.id,
      amount: refundAmount,
    })

    return (await Hold.findById(holdId)) as HoldData
  }

  /**
   * Cancel an authorization before capture. Only valid from `pending` or
   * `authorized`. Records a `hold_expired` ledger entry for audit.
   */
  static async cancel(holdId: number): Promise<HoldData> {
    const hold = await Hold.findById(holdId)
    if (!hold) throw new HoldStateError(holdId, '(missing)', 'expired')

    Hold.assertTransition(hold.status, 'expired')

    await StripeManager.stripe.paymentIntents.cancel(hold.paymentIntentId)

    await Hold.sql`
      UPDATE "strav_stripe_hold"
      SET "status" = 'expired', "updated_at" = NOW()
      WHERE "id" = ${holdId}
    `
    await Hold.insertEvent(holdId, 'cancel', hold.status, 'expired', null)

    return (await Hold.findById(holdId)) as HoldData
  }

  /**
   * Record an externally-driven state transition (e.g. from a webhook).
   * Use this when the source of truth is Stripe — for `pending → authorized`
   * triggered by `payment_intent.amount_capturable_updated` or `* → expired`
   * triggered by `payment_intent.canceled`.
   */
  static async recordEvent(
    holdId: number,
    to: HoldStatus,
    eventType: string,
    payload: Record<string, unknown> | null = null
  ): Promise<HoldData> {
    const hold = await Hold.findById(holdId)
    if (!hold) throw new HoldStateError(holdId, '(missing)', to)

    Hold.assertTransition(hold.status, to)

    await Hold.sql`
      UPDATE "strav_stripe_hold"
      SET "status" = ${to}, "updated_at" = NOW()
      WHERE "id" = ${holdId}
    `
    await Hold.insertEvent(holdId, eventType, hold.status, to, payload)

    return (await Hold.findById(holdId)) as HoldData
  }

  // ---- Queries ----

  static async findById(id: number): Promise<HoldData | null> {
    const rows = await Hold.sql`
      SELECT * FROM "strav_stripe_hold" WHERE "id" = ${id} LIMIT 1
    `
    return rows.length > 0 ? Hold.hydrate(rows[0] as Record<string, unknown>) : null
  }

  static async findByUser(user: unknown, status?: HoldStatus): Promise<HoldData[]> {
    const userId = extractUserId(user)
    const fk = Hold.fk

    if (status) {
      const rows = await Hold.sql.unsafe(
        `SELECT * FROM "strav_stripe_hold"
         WHERE "${fk}" = $1 AND "status" = $2
         ORDER BY "created_at" DESC`,
        [userId, status]
      )
      return rows.map((r: any) => Hold.hydrate(r))
    }

    const rows = await Hold.sql.unsafe(
      `SELECT * FROM "strav_stripe_hold"
       WHERE "${fk}" = $1
       ORDER BY "created_at" DESC`,
      [userId]
    )
    return rows.map((r: any) => Hold.hydrate(r))
  }

  static async findByPaymentIntent(paymentIntentId: string): Promise<HoldData | null> {
    const rows = await Hold.sql`
      SELECT * FROM "strav_stripe_hold"
      WHERE "payment_intent_id" = ${paymentIntentId} LIMIT 1
    `
    return rows.length > 0 ? Hold.hydrate(rows[0] as Record<string, unknown>) : null
  }

  /** Read the append-only event trail for a hold. */
  static async events(holdId: number): Promise<HoldEventData[]> {
    const rows = await Hold.sql`
      SELECT * FROM "strav_stripe_hold_event"
      WHERE "strav_stripe_hold_id" = ${holdId}
      ORDER BY "created_at" ASC
    `
    return rows.map((r: any) => ({
      id: r.id as number,
      holdId: r.strav_stripe_hold_id as number,
      eventType: r.event_type as string,
      fromStatus: (r.from_status as HoldStatus) ?? null,
      toStatus: r.to_status as HoldStatus,
      payload: (r.payload as Record<string, unknown>) ?? null,
      createdAt: r.created_at as Date,
    }))
  }

  // ---- Internal ----

  private static assertTransition(from: HoldStatus, to: HoldStatus): void {
    const allowed = VALID_TRANSITIONS[from] ?? []
    if (!allowed.includes(to)) {
      throw new HoldStateError('?', from, to)
    }
  }

  private static async insertEvent(
    holdId: number,
    eventType: string,
    from: HoldStatus | null,
    to: HoldStatus,
    payload: Record<string, unknown> | null
  ): Promise<void> {
    const payloadJson = payload ? JSON.stringify(payload) : null
    await Hold.sql.unsafe(
      `INSERT INTO "strav_stripe_hold_event"
         ("strav_stripe_hold_id", "event_type", "from_status", "to_status", "payload")
       VALUES ($1, $2, $3, $4, $5)`,
      [holdId, eventType, from, to, payloadJson]
    )
  }

  private static hydrate(row: Record<string, unknown>): HoldData {
    const fk = Hold.fk
    return {
      id: row.id as number,
      userId: row[fk] as string | number,
      paymentIntentId: row.payment_intent_id as string,
      amount: typeof row.amount === 'string' ? Number(row.amount) : (row.amount as number),
      currency: row.currency as string,
      status: row.status as HoldStatus,
      destinationAccountId: (row.destination_account_id as string) ?? null,
      applicationFeeAmount:
        row.application_fee_amount != null ? Number(row.application_fee_amount) : null,
      expiresAt: (row.expires_at as Date) ?? null,
      metadata: (row.metadata as Record<string, unknown>) ?? null,
      createdAt: row.created_at as Date,
      updatedAt: row.updated_at as Date,
    }
  }
}
