import { extractUserId } from '@strav/database'
import StripeManager from '../stripe_manager.ts'
import type { LedgerEntryData, LedgerEntryType, LedgerDirection } from '../types.ts'

/**
 * Append-only money-movement log backed by the `strav_stripe_ledger` table.
 *
 * Every Stripe-side cash flow (charge, refund, transfer, application fee,
 * payout, dispute) writes exactly one row. Corrections happen via a
 * reversing entry — never an update. The schema enforces this at the DB
 * layer via the trigger in `stubs/migrations/strav_stripe_ledger_triggers.sql`.
 *
 * The class deliberately exposes no `update`/`delete` methods; mutation is
 * impossible by API contract.
 *
 * @example
 * await Ledger.record({
 *   user: clientUser,
 *   entryType: 'charge',
 *   direction: 'debit',
 *   amount: 1_000_00, // $1,000 in cents
 *   currency: 'usd',
 *   stripeIntentId: 'pi_xxx',
 *   description: 'Milestone 1 funding',
 * })
 *
 * const recent = await Ledger.findByUser(clientUser, { limit: 50 })
 */
export default class Ledger {
  private static get sql() {
    return StripeManager.db.sql
  }

  private static get fk() {
    return StripeManager.userFkColumn
  }

  /** Insert a new ledger entry. Returns the persisted row. */
  static async record(entry: {
    user: unknown
    entryType: LedgerEntryType
    direction: LedgerDirection
    amount: number
    currency?: string
    stripeIntentId?: string | null
    stripeChargeId?: string | null
    stripeTransferId?: string | null
    connectAccountId?: string | null
    holdId?: number | null
    description?: string | null
    metadata?: Record<string, unknown> | null
  }): Promise<LedgerEntryData> {
    const userId = extractUserId(entry.user)
    const fk = Ledger.fk
    const currency = entry.currency ?? StripeManager.config.currency
    const metadataJson = entry.metadata ? JSON.stringify(entry.metadata) : null

    const rows = await Ledger.sql.unsafe(
      `INSERT INTO "strav_stripe_ledger"
         ("${fk}", "entry_type", "direction", "amount", "currency",
          "stripe_intent_id", "stripe_charge_id", "stripe_transfer_id",
          "connect_account_id", "hold_id", "description", "metadata")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       RETURNING *`,
      [
        userId,
        entry.entryType,
        entry.direction,
        entry.amount,
        currency,
        entry.stripeIntentId ?? null,
        entry.stripeChargeId ?? null,
        entry.stripeTransferId ?? null,
        entry.connectAccountId ?? null,
        entry.holdId ?? null,
        entry.description ?? null,
        metadataJson,
      ]
    )
    return Ledger.hydrate(rows[0] as Record<string, unknown>)
  }

  /** Find ledger entries for a user, newest first. */
  static async findByUser(
    user: unknown,
    options: { limit?: number; entryType?: LedgerEntryType } = {}
  ): Promise<LedgerEntryData[]> {
    const userId = extractUserId(user)
    const fk = Ledger.fk
    const limit = options.limit ?? 100

    if (options.entryType) {
      const rows = await Ledger.sql.unsafe(
        `SELECT * FROM "strav_stripe_ledger"
         WHERE "${fk}" = $1 AND "entry_type" = $2
         ORDER BY "created_at" DESC
         LIMIT $3`,
        [userId, options.entryType, limit]
      )
      return rows.map((r: any) => Ledger.hydrate(r))
    }

    const rows = await Ledger.sql.unsafe(
      `SELECT * FROM "strav_stripe_ledger"
       WHERE "${fk}" = $1
       ORDER BY "created_at" DESC
       LIMIT $2`,
      [userId, limit]
    )
    return rows.map((r: any) => Ledger.hydrate(r))
  }

  /** Find all ledger entries tied to a Stripe PaymentIntent. */
  static async findByIntent(stripeIntentId: string): Promise<LedgerEntryData[]> {
    const rows = await Ledger.sql`
      SELECT * FROM "strav_stripe_ledger"
      WHERE "stripe_intent_id" = ${stripeIntentId}
      ORDER BY "created_at" ASC
    `
    return rows.map((r: any) => Ledger.hydrate(r))
  }

  /** Find all ledger entries tied to a Hold (by local id). */
  static async findByHold(holdId: number): Promise<LedgerEntryData[]> {
    const rows = await Ledger.sql`
      SELECT * FROM "strav_stripe_ledger"
      WHERE "hold_id" = ${holdId}
      ORDER BY "created_at" ASC
    `
    return rows.map((r: any) => Ledger.hydrate(r))
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private static hydrate(row: Record<string, unknown>): LedgerEntryData {
    const fk = Ledger.fk
    return {
      id: row.id as number,
      userId: row[fk] as string | number,
      entryType: row.entry_type as LedgerEntryType,
      direction: row.direction as LedgerDirection,
      amount: typeof row.amount === 'string' ? Number(row.amount) : (row.amount as number),
      currency: row.currency as string,
      stripeIntentId: (row.stripe_intent_id as string) ?? null,
      stripeChargeId: (row.stripe_charge_id as string) ?? null,
      stripeTransferId: (row.stripe_transfer_id as string) ?? null,
      connectAccountId: (row.connect_account_id as string) ?? null,
      holdId: row.hold_id != null ? Number(row.hold_id) : null,
      description: (row.description as string) ?? null,
      metadata: (row.metadata as Record<string, unknown>) ?? null,
      createdAt: row.created_at as Date,
    }
  }
}
