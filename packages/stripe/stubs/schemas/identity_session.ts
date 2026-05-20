import { defineSchema, t, Archetype } from '@strav/database/schema'

/**
 * Local mirror of a Stripe Identity verification session.
 *
 * One row per session created via `StripeIdentity.createVerificationSession`;
 * synced from the `identity.verification_session.*` webhooks. Do not write
 * to `status` directly — let webhooks drive it.
 *
 * Stores only the session id + status flag + document-country code; the
 * raw PII (document images, selfies) stays on Stripe's side.
 */
export default defineSchema('strav_stripe_identity_session', {
  archetype: Archetype.Component,
  parents: ['user'],
  fields: {
    stripeSessionId: t.varchar(255).required().unique().index(),
    type: t.varchar(20).required(), // 'document' | 'id_number'
    status: t.varchar(30).required().index(),
    documentCountry: t.varchar(2).nullable(),
    documentType: t.varchar(30).nullable(),
    lastErrorCode: t.varchar(50).nullable(),
    lastErrorReason: t.text().nullable(),
    verifiedAt: t.timestamptz().nullable(),
    canceledAt: t.timestamptz().nullable(),
    metadata: t.jsonb().nullable(),
  },
})
