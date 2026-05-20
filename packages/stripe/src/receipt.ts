import StripeManager from './stripe_manager.ts'
import Ledger from './ledger/ledger.ts'
import { extractUserId } from '@strav/database'
import type { ReceiptData } from './types.ts'

let deprecationWarned = false
function warnOnce(method: string): void {
  if (deprecationWarned) return
  deprecationWarned = true
  // eslint-disable-next-line no-console
  console.warn(
    `[@strav/stripe] Receipt.${method}() is deprecated and now reads/writes ` +
      `strav_stripe_ledger (entry_type='charge'). Prefer Ledger.* or stripe.ledger(). ` +
      `Receipt will be removed in the next minor release.`
  )
}

/**
 * @deprecated Use {@link Ledger} (writes) or `stripe.ledger(user)` (reads).
 *
 * Thin backwards-compatibility shim. Routes all writes and reads through
 * the append-only `strav_stripe_ledger` table (entry_type='charge'). The
 * `receipt` table itself is no longer maintained; existing apps should run
 * `bun strav stripe:migrate-receipts` once to backfill, then drop the
 * legacy table.
 */
export default class Receipt {
  private static get sql() {
    return StripeManager.db.sql
  }

  private static get fk() {
    return StripeManager.userFkColumn
  }

  /** @deprecated Delegates to `Ledger.record({ entryType: 'charge', direction: 'debit' })`. */
  static async create(data: {
    user: unknown
    stripeId: string
    amount: number
    currency: string
    description?: string | null
    receiptUrl?: string | null
  }): Promise<ReceiptData> {
    warnOnce('create')

    const entry = await Ledger.record({
      user: data.user,
      entryType: 'charge',
      direction: 'debit',
      amount: data.amount,
      currency: data.currency,
      stripeIntentId: data.stripeId,
      description: data.description ?? null,
      metadata: data.receiptUrl ? { receiptUrl: data.receiptUrl } : null,
    })

    return Receipt.ledgerToReceipt(entry, data.receiptUrl ?? null)
  }

  /** @deprecated Reads from `strav_stripe_ledger` where entry_type='charge'. */
  static async findByUser(user: unknown): Promise<ReceiptData[]> {
    warnOnce('findByUser')
    const userId = extractUserId(user)
    const fk = Receipt.fk
    const rows = await Receipt.sql.unsafe(
      `SELECT * FROM "strav_stripe_ledger"
       WHERE "${fk}" = $1 AND "entry_type" = 'charge'
       ORDER BY "created_at" DESC`,
      [userId]
    )
    return rows.map((r: any) => Receipt.rowToReceipt(r))
  }

  /** @deprecated Reads from `strav_stripe_ledger` by stripe_intent_id. */
  static async findByStripeId(stripeId: string): Promise<ReceiptData | null> {
    warnOnce('findByStripeId')
    const rows = await Receipt.sql`
      SELECT * FROM "strav_stripe_ledger"
      WHERE "stripe_intent_id" = ${stripeId} AND "entry_type" = 'charge'
      LIMIT 1
    `
    return rows.length > 0 ? Receipt.rowToReceipt(rows[0] as any) : null
  }

  // ---------------------------------------------------------------------------
  // Internal — map ledger row → ReceiptData shape
  // ---------------------------------------------------------------------------

  private static rowToReceipt(row: Record<string, unknown>): ReceiptData {
    const fk = Receipt.fk
    const metadata = (row.metadata as Record<string, unknown> | null) ?? null
    return {
      id: row.id as number,
      userId: row[fk] as string | number,
      stripeId: row.stripe_intent_id as string,
      amount: typeof row.amount === 'string' ? Number(row.amount) : (row.amount as number),
      currency: row.currency as string,
      description: (row.description as string) ?? null,
      receiptUrl: (metadata?.receiptUrl as string) ?? null,
      createdAt: row.created_at as Date,
    }
  }

  private static ledgerToReceipt(
    entry: import('./types.ts').LedgerEntryData,
    receiptUrl: string | null
  ): ReceiptData {
    return {
      id: entry.id,
      userId: entry.userId,
      stripeId: entry.stripeIntentId ?? '',
      amount: entry.amount,
      currency: entry.currency,
      description: entry.description,
      receiptUrl,
      createdAt: entry.createdAt,
    }
  }
}
