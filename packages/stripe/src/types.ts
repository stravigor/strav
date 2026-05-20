import type Stripe from 'stripe'

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface StripeConfig {
  /** Stripe secret key. */
  secret: string
  /** Stripe publishable key (passed to frontend). */
  key: string
  /** Stripe webhook signing secret. */
  webhookSecret: string
  /** Default currency code (lowercase). */
  currency: string
  /** The user model's primary key property name (e.g. 'id', 'uid'). */
  userKey: string
  /** URL prefix for Checkout success/cancel. */
  urls: {
    success: string
    cancel: string
  }
  /** Stripe Connect (marketplace) settings. Disabled by default. */
  connect: {
    /** When false, all Connect APIs throw {@link ConnectNotConfiguredError}. */
    enabled: boolean
    /** Default account type for new Connect accounts. */
    accountType: ConnectAccountType
    /** Default ISO 3166-1 alpha-2 country (e.g. 'US'). */
    defaultCountry: string
    /** Default `business_type` for new accounts. */
    defaultBusinessType: 'individual' | 'company' | 'non_profit' | 'government_entity'
    /** URL the Stripe onboarding link redirects to when interrupted. */
    refreshUrl: string
    /** URL the Stripe onboarding link redirects to on completion. */
    returnUrl: string
  }
  /** Webhook-handler settings. */
  webhook: {
    /**
     * Enable idempotency dedup on the `strav_stripe_webhook_event` table.
     * Defaults to `false` for backwards compatibility; flip in next major.
     */
    idempotency: boolean
  }
}

// ---------------------------------------------------------------------------
// Connect
// ---------------------------------------------------------------------------

export type ConnectAccountType = 'express' | 'custom' | 'standard'

export interface ConnectAccountData {
  id: number
  userId: string | number
  stripeAccountId: string
  accountType: ConnectAccountType
  country: string
  chargesEnabled: boolean
  payoutsEnabled: boolean
  detailsSubmitted: boolean
  capabilities: Record<string, unknown> | null
  requirements: Record<string, unknown> | null
  createdAt: Date
  updatedAt: Date
}

export interface ConnectAccountStatus {
  chargesEnabled: boolean
  payoutsEnabled: boolean
  detailsSubmitted: boolean
  capabilities: Record<string, unknown> | null
  requirements: Record<string, unknown> | null
}

// ---------------------------------------------------------------------------
// Hold (escrow)
// ---------------------------------------------------------------------------

export type HoldStatus = 'pending' | 'authorized' | 'released' | 'refunded' | 'expired'

export interface HoldData {
  id: number
  userId: string | number
  paymentIntentId: string
  amount: number
  currency: string
  status: HoldStatus
  destinationAccountId: string | null
  applicationFeeAmount: number | null
  expiresAt: Date | null
  metadata: Record<string, unknown> | null
  createdAt: Date
  updatedAt: Date
}

export interface HoldEventData {
  id: number
  holdId: number
  eventType: string
  fromStatus: HoldStatus | null
  toStatus: HoldStatus
  payload: Record<string, unknown> | null
  createdAt: Date
}

export interface HoldReleaseOptions {
  /** Connect account ID (`acct_…`) to transfer the captured funds to. */
  destination: string
  /** Platform fee in cents, withheld from the transfer. Default 0. */
  applicationFeeAmount?: number
  /** Partial capture amount (cents). Defaults to the full authorized amount. */
  amountToCapture?: number
  /** Description copied to the ledger entries. */
  description?: string
}

// ---------------------------------------------------------------------------
// Ledger (append-only)
// ---------------------------------------------------------------------------

export type LedgerEntryType =
  | 'charge'
  | 'refund'
  | 'transfer'
  | 'application_fee'
  | 'hold_authorized'
  | 'hold_released'
  | 'hold_refunded'
  | 'hold_expired'
  | 'payout'
  | 'dispute'
  | 'adjustment'

export type LedgerDirection = 'debit' | 'credit'

export interface LedgerEntryData {
  id: number
  userId: string | number
  entryType: LedgerEntryType
  direction: LedgerDirection
  amount: number
  currency: string
  stripeIntentId: string | null
  stripeChargeId: string | null
  stripeTransferId: string | null
  connectAccountId: string | null
  holdId: number | null
  description: string | null
  metadata: Record<string, unknown> | null
  createdAt: Date
}

// ---------------------------------------------------------------------------
// Identity (KYC verification sessions)
// ---------------------------------------------------------------------------

export type IdentitySessionType = 'document' | 'id_number'

export type IdentitySessionStatus =
  | 'requires_input'
  | 'processing'
  | 'verified'
  | 'canceled'
  | 'failed'

export interface IdentitySessionData {
  id: number
  userId: string | number
  stripeSessionId: string
  type: IdentitySessionType
  status: IdentitySessionStatus
  documentCountry: string | null
  documentType: string | null
  lastErrorCode: string | null
  lastErrorReason: string | null
  verifiedAt: Date | null
  canceledAt: Date | null
  metadata: Record<string, unknown> | null
  createdAt: Date
  updatedAt: Date
}

/** Created session — includes the secrets needed to redirect / embed. */
export interface IdentitySessionCreated extends IdentitySessionData {
  /** Hosted Stripe URL the user should be redirected to. */
  url: string
  /** Client secret for embedded flows. */
  clientSecret: string | null
}

// ---------------------------------------------------------------------------
// Data Records
// ---------------------------------------------------------------------------

export interface CustomerData {
  id: number
  userId: string | number
  stripeId: string
  pmType: string | null
  pmLastFour: string | null
  trialEndsAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface SubscriptionData {
  id: number
  userId: string | number
  name: string
  stripeId: string
  stripeStatus: string
  stripePriceId: string | null
  quantity: number | null
  trialEndsAt: Date | null
  endsAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface SubscriptionItemData {
  id: number
  subscriptionId: number
  stripeId: string
  stripeProductId: string
  stripePriceId: string
  quantity: number | null
  createdAt: Date
  updatedAt: Date
}

export interface ReceiptData {
  id: number
  userId: string | number
  stripeId: string
  amount: number
  currency: string
  description: string | null
  receiptUrl: string | null
  createdAt: Date
}

// ---------------------------------------------------------------------------
// Subscription Status
// ---------------------------------------------------------------------------

export const SubscriptionStatus = {
  Active: 'active',
  Canceled: 'canceled',
  Incomplete: 'incomplete',
  IncompleteExpired: 'incomplete_expired',
  PastDue: 'past_due',
  Paused: 'paused',
  Trialing: 'trialing',
  Unpaid: 'unpaid',
} as const

export type SubscriptionStatusValue = (typeof SubscriptionStatus)[keyof typeof SubscriptionStatus]

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

export type WebhookEventHandler = (event: Stripe.Event) => void | Promise<void>
