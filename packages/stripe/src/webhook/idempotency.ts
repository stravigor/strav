import StripeManager from '../stripe_manager.ts'

/**
 * Webhook idempotency dedup, backed by the `strav_stripe_webhook_event` table.
 *
 * On each webhook delivery, after Stripe-signature verification, the handler
 * calls {@link checkAndRecordEvent}. The `INSERT ... ON CONFLICT DO NOTHING
 * RETURNING id` atomically claims the event id; only the winning caller
 * dispatches handlers. Concurrent deliveries from Stripe's retry mechanism
 * race on the unique constraint; PostgreSQL guarantees exactly one winner.
 *
 * Only invoked when `config.stripe.webhook.idempotency` is true.
 */

/**
 * Atomically record receipt of a Stripe event. Returns `true` if this call
 * was the first to see the event id (proceed with dispatch); `false` if a
 * prior delivery already recorded it (skip dispatch, return 200).
 */
export async function checkAndRecordEvent(
  stripeEventId: string,
  eventType: string
): Promise<boolean> {
  const rows = await StripeManager.db.sql`
    INSERT INTO "strav_stripe_webhook_event" ("stripe_event_id", "event_type")
    VALUES (${stripeEventId}, ${eventType})
    ON CONFLICT ("stripe_event_id") DO NOTHING
    RETURNING "id"
  `
  return rows.length > 0
}

/**
 * Mark an event as fully processed (observability only — not used in dedup
 * decisions). Called after all handlers complete successfully.
 */
export async function markEventProcessed(stripeEventId: string): Promise<void> {
  await StripeManager.db.sql`
    UPDATE "strav_stripe_webhook_event"
    SET "processed_at" = NOW()
    WHERE "stripe_event_id" = ${stripeEventId}
  `
}
