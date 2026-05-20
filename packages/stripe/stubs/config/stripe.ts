import { env } from '@strav/kernel/helpers'

export default {
  /** Stripe secret key. */
  secret: env('STRIPE_SECRET', ''),

  /** Stripe publishable key. */
  key: env('STRIPE_KEY', ''),

  /** Stripe webhook signing secret. */
  webhookSecret: env('STRIPE_WEBHOOK_SECRET', ''),

  /** Default currency for charges. */
  currency: 'usd',

  /**
   * The user model's primary key property (determines FK column name).
   * 'id' → user_id, 'uid' → user_uid, etc.
   */
  userKey: 'id',

  /** URLs for Stripe Checkout success/cancel redirects. */
  urls: {
    success: env('APP_URL', 'http://localhost:3000') + '/billing/success',
    cancel: env('APP_URL', 'http://localhost:3000') + '/billing/cancel',
  },

  /**
   * Stripe Connect (marketplace payments). When `enabled` is false, every
   * Connect / Hold API throws `ConnectNotConfiguredError`. Existing SaaS
   * flows (customer sync, subscriptions, charges) are unaffected.
   */
  connect: {
    enabled: env('STRIPE_CONNECT_ENABLED', 'false') === 'true',
    /** 'express' (Stripe-hosted onboarding), 'custom' (you host), or 'standard'. */
    accountType: env('STRIPE_CONNECT_ACCOUNT_TYPE', 'express'),
    defaultCountry: env('STRIPE_CONNECT_DEFAULT_COUNTRY', 'US'),
    defaultBusinessType: env('STRIPE_CONNECT_DEFAULT_BUSINESS_TYPE', 'individual'),
    refreshUrl: env('APP_URL', 'http://localhost:3000') + '/billing/connect/refresh',
    returnUrl: env('APP_URL', 'http://localhost:3000') + '/billing/connect/complete',
  },

  /** Webhook handler settings. */
  webhook: {
    /**
     * Deduplicate events on the `strav_stripe_webhook_event` table so
     * Stripe retries don't double-dispatch. Off by default; flip in a
     * future major release.
     */
    idempotency: env('STRIPE_WEBHOOK_IDEMPOTENCY', 'false') === 'true',
  },
}
