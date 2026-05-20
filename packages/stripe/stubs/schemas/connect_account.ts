import { defineSchema, t, Archetype } from '@strav/database/schema'

/**
 * Local mirror of a Stripe Connect account.
 *
 * One row per onboarded freelancer / merchant. Synced from Stripe via the
 * `account.updated` / `capability.updated` webhooks; do not write directly.
 */
export default defineSchema('strav_stripe_connect_account', {
  archetype: Archetype.Component,
  parents: ['user'],
  fields: {
    stripeAccountId: t.varchar(255).required().unique().index(),
    accountType: t.varchar(20).required(), // 'express' | 'custom' | 'standard'
    country: t.varchar(2).required(),
    chargesEnabled: t.boolean().required().default(false),
    payoutsEnabled: t.boolean().required().default(false),
    detailsSubmitted: t.boolean().required().default(false),
    capabilities: t.jsonb().nullable(),
    requirements: t.jsonb().nullable(),
  },
})
