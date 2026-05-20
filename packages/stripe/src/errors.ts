import { StravError } from '@strav/kernel'

/** Base error class for all Stripe billing errors. */
export class StripeError extends StravError {}

/** Thrown when webhook signature verification fails. */
export class WebhookSignatureError extends StripeError {
  constructor() {
    super('Stripe webhook signature verification failed.')
  }
}

/** Thrown when a user has no Stripe customer record. */
export class CustomerNotFoundError extends StripeError {
  constructor() {
    super('No Stripe customer found for this user.')
  }
}

/** Thrown when a subscription is not found. */
export class SubscriptionNotFoundError extends StripeError {
  constructor(name: string) {
    super(`No subscription named "${name}" found for this user.`)
  }
}

/** Thrown when a payment method operation fails on Stripe. */
export class PaymentMethodError extends StripeError {}

/** Thrown when a subscription creation fails on Stripe. */
export class SubscriptionCreationError extends StripeError {}

/**
 * Thrown when a `Hold` state-machine transition is illegal.
 * See `Hold` in `src/hold/hold.ts` for the valid transition table.
 */
export class HoldStateError extends StripeError {
  constructor(holdId: number | string, from: string, to: string) {
    super(`Hold ${holdId}: illegal transition from "${from}" to "${to}".`)
  }
}

/** Thrown when a Stripe Connect API is invoked but `stripe.connect.enabled` is false. */
export class ConnectNotConfiguredError extends StripeError {
  constructor() {
    super(
      'Stripe Connect is not enabled. Set `stripe.connect.enabled = true` in config/stripe.ts.'
    )
  }
}

/** Thrown when webhook idempotency machinery encounters an inconsistent state. */
export class IdempotencyError extends StripeError {}
