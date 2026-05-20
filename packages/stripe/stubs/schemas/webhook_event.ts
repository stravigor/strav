import { defineSchema, t, Archetype } from '@strav/database/schema'

/**
 * Idempotency dedup table for Stripe webhooks.
 *
 * On webhook receipt (after signature verification), an `INSERT ... ON
 * CONFLICT DO NOTHING` keyed on `stripeEventId` decides whether to dispatch
 * handlers. Concurrent deliveries race on the unique constraint; exactly one
 * wins. Only enabled when `config.stripe.webhook.idempotency` is true.
 */
export default defineSchema('strav_stripe_webhook_event', {
  archetype: Archetype.Event,
  fields: {
    stripeEventId: t.varchar(255).required().unique().index(),
    eventType: t.varchar(100).required().index(),
    processedAt: t.timestamptz().nullable(),
  },
})
