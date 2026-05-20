import { defineSchema, t, Archetype } from '@strav/database/schema'

/**
 * Escrow hold backed by a manual-capture Stripe PaymentIntent.
 *
 * Status lifecycle (enforced by the `Hold` class, never write directly):
 *   pending → authorized → released | refunded | expired
 *                    └──→ refunded
 *
 * Released holds may still be refunded (full reversal).
 */
export default defineSchema('strav_stripe_hold', {
  archetype: Archetype.Component,
  parents: ['user'],
  fields: {
    paymentIntentId: t.varchar(255).required().unique().index(),
    amount: t.bigint().required(),
    currency: t.varchar(3).required(),
    status: t.varchar(20).required().index(),
    destinationAccountId: t.varchar(255).nullable(),
    applicationFeeAmount: t.bigint().nullable(),
    expiresAt: t.timestamptz().nullable(),
    metadata: t.jsonb().nullable(),
  },
})
