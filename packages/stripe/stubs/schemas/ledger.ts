import { defineSchema, t, Archetype } from '@strav/database/schema'

/**
 * Append-only money-movement log.
 *
 * Every Stripe charge, refund, transfer, application fee, payout and dispute
 * writes one row. Corrections are reversing entries (a new row with the
 * opposite direction), never updates. `UPDATE`/`DELETE` blocked at the DB
 * layer by the trigger in `stubs/migrations/strav_stripe_ledger_triggers.sql`.
 *
 * Replaces the legacy `receipt` table (which only tracked charges).
 */
export default defineSchema('strav_stripe_ledger', {
  archetype: Archetype.Event,
  parents: ['user'],
  fields: {
    entryType: t.varchar(30).required().index(),
    direction: t.varchar(10).required(), // 'debit' | 'credit'
    amount: t.bigint().required(), // always positive cents
    currency: t.varchar(3).required(),
    stripeIntentId: t.varchar(255).nullable().index(),
    stripeChargeId: t.varchar(255).nullable().index(),
    stripeTransferId: t.varchar(255).nullable().index(),
    connectAccountId: t.varchar(255).nullable(),
    holdId: t.bigint().nullable(),
    description: t.text().nullable(),
    metadata: t.jsonb().nullable(),
  },
})
