# @strav/stripe

Stripe billing integration — subscriptions, one-time charges, checkout sessions, invoices, payment methods, and webhooks. Attach billing capabilities to user models with the billable() mixin.

## Dependencies
- @strav/kernel (peer)
- @strav/database (peer)
- @strav/http (peer)

## Commands
- bun test
- bun run build

## Architecture
- src/stripe_manager.ts — main manager class
- src/stripe_provider.ts — service provider registration
- src/billable.ts — mixin to add billing to ORM models
- src/customer.ts — Stripe customer management
- src/subscription.ts — subscription lifecycle
- src/subscription_builder.ts — fluent subscription creation
- src/subscription_item.ts — individual subscription items
- src/checkout_builder.ts — Stripe checkout session builder
- src/invoice.ts — invoice handling
- src/payment_method.ts — payment method management
- src/receipt.ts — DEPRECATED; thin delegator to Ledger
- src/webhook.ts — Stripe webhook handling
- src/webhook/idempotency.ts — webhook dedup (`checkAndRecordEvent`)
- src/connect/connect.ts — Stripe Connect account onboarding + mirror
- src/hold/hold.ts — escrow Hold primitive (state machine)
- src/ledger/ledger.ts — append-only money-movement log
- src/identity/identity.ts — Stripe Identity (KYC) verification sessions + mirror
- src/types.ts — type definitions
- src/errors.ts — package-specific errors
- stubs/schemas/* — Drizzle-style schema stubs copied into the consumer app
- stubs/migrations/strav_stripe_ledger_triggers.sql — INSERT-only enforcement triggers

## Conventions
- Use the billable() mixin on user models — don't call Stripe directly
- Webhook handling is centralized in webhook.ts
- Subscription state changes go through the subscription builder pattern
- Hold state transitions go through `Hold.release/refund/cancel` (or `Hold.recordEvent` from a webhook handler) — never UPDATE `strav_stripe_hold.status` directly
- Ledger is append-only; corrections are reversing entries (new row, opposite direction), not updates
- Connect APIs throw `ConnectNotConfiguredError` when `stripe.connect.enabled` is false; gate-checks live in `StripeConnect.assertEnabled()`
- Webhook idempotency is opt-in via `stripeWebhook({ idempotency: true })` or `stripe.webhook.idempotency = true` config; defaults to off for backwards compat
- Stripe Identity is **not** gated by `connect.enabled` (separate Stripe product); local mirror in `strav_stripe_identity_session` is webhook-driven, never written via app code's UPDATE
