import { defineSchema, t, Archetype } from '@strav/database/schema'

/**
 * Append-only audit trail of `strav_stripe_hold` state transitions.
 *
 * One row per state change. `UPDATE`/`DELETE` blocked at the DB layer by
 * the trigger in `stubs/migrations/strav_stripe_ledger_triggers.sql`.
 */
export default defineSchema('strav_stripe_hold_event', {
  archetype: Archetype.Event,
  parents: ['strav_stripe_hold'],
  fields: {
    eventType: t.varchar(50).required().index(),
    fromStatus: t.varchar(20).nullable(),
    toStatus: t.varchar(20).required(),
    payload: t.jsonb().nullable(),
  },
})
