/**
 * Built-in gateway names. Apps can register custom gateways under any
 * string id; this union narrows the discriminator for the two adapters
 * that ship in @strav/payments.
 */
export type GatewayName = 'omise' | 'stripe'

/**
 * ISO-4217 currency code, lowercased to match what Stripe and Omise expect
 * on the wire. e.g. 'thb', 'usd', 'jpy'.
 */
export type CurrencyCode = string

/**
 * Amount as the smallest currency unit (satang for THB, cents for USD).
 *
 * Both Stripe and Omise use minor units; we standardise on integers to
 * keep the boundary clear and avoid floating-point bugs. For THB, 99.00
 * baht = 9900 satang.
 */
export type MinorAmount = number

/**
 * Canonical payment-method types supported across gateways.
 *
 * `card` is the universal off-session-capable method. `promptpay` is the
 * single-use Thai bank-redirect method — both Omise and Stripe (TH) support
 * it, but neither can save it for recurring off-session use. Recurring
 * PromptPay is app-driven: schedule a fresh charge each cycle and deliver
 * the QR back to the customer (typically via LINE — see ./line/).
 */
export type PaymentMethodType = 'card' | 'promptpay'

/** A reference to a payment method already stored on the gateway. */
export interface SavedPaymentMethod {
  id: string
  type: PaymentMethodType
  /** Last four digits (cards only). */
  last4?: string
  /** Card brand (cards only). e.g. 'visa', 'mastercard'. */
  brand?: string
  /** Card expiry month / year (cards only). */
  expMonth?: number
  expYear?: number
  raw: unknown
}

/** Customer record on the gateway side. */
export interface GatewayCustomer {
  id: string
  email?: string
  name?: string
  metadata?: Record<string, string>
  raw: unknown
}

/**
 * Action the customer needs to take before the charge can settle.
 *
 * For PromptPay this is a QR code the customer scans in their bank app.
 * `imageUrl` is a server-hosted PNG; `payload` is the raw EMV-QR string
 * (Omise returns this directly; Stripe wraps it in the image).
 */
export interface PromptPayAction {
  type: 'promptpay_display_qr'
  imageUrl?: string
  payload?: string
  /** When the QR expires (gateway-enforced; typically a few minutes). */
  expiresAt?: Date
}

export type NextAction = PromptPayAction

/**
 * Status of a one-off charge.
 *
 * - `succeeded`: funds captured.
 * - `pending`: payment created but not yet settled (PromptPay before scan,
 *   bank-transfer in flight).
 * - `requires_action`: blocked on customer action (PromptPay QR scan, 3DS).
 *   `nextAction` is populated in this case.
 * - `failed`: gateway rejected the charge.
 */
export type ChargeStatus = 'succeeded' | 'pending' | 'requires_action' | 'failed'

export interface Charge {
  id: string
  amount: MinorAmount
  currency: CurrencyCode
  status: ChargeStatus
  /** Action the customer must take before the charge can settle. */
  nextAction?: NextAction
  /** Gateway customer ID, if the charge is bound to one. */
  customerId?: string
  /** Original gateway response — provider-specific. */
  raw: unknown
}

/** Lifecycle status of a card-based subscription. */
export type SubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'incomplete'
  | 'incomplete_expired'

export interface Subscription {
  id: string
  customerId: string
  status: SubscriptionStatus
  /** Gateway-specific identifier for the price/plan. */
  planId: string
  currentPeriodStart?: Date
  currentPeriodEnd?: Date
  cancelAt?: Date
  metadata?: Record<string, string>
  raw: unknown
}

/**
 * Canonical webhook event shape across gateways.
 *
 * The `type` discriminator is normalised across providers:
 *   - `charge.succeeded`        — terminal success
 *   - `charge.pending`          — created but not settled
 *   - `charge.failed`           — terminal failure
 *   - `charge.requires_action`  — QR / 3DS waiting on customer
 *   - `subscription.created`
 *   - `subscription.renewed`    — successful renewal
 *   - `subscription.canceled`
 *   - `subscription.payment_failed`
 *
 * Anything outside this set comes through with type `unknown` and the
 * raw payload available for app-specific handling.
 */
export type CanonicalEventType =
  | 'charge.succeeded'
  | 'charge.pending'
  | 'charge.failed'
  | 'charge.requires_action'
  | 'subscription.created'
  | 'subscription.renewed'
  | 'subscription.canceled'
  | 'subscription.payment_failed'
  | 'unknown'

export interface WebhookEvent {
  type: CanonicalEventType
  /** Gateway-side event ID for idempotency. */
  id: string
  /** Charge or Subscription depending on `type`. */
  resource: Charge | Subscription | null
  /** Original gateway payload. */
  raw: unknown
}

/** Customer creation input. */
export interface CreateCustomerInput {
  email?: string
  name?: string
  metadata?: Record<string, string>
}

/** Charge creation input. */
export interface CreateChargeInput {
  amount: MinorAmount
  currency: CurrencyCode
  /**
   * For card charges: the gateway customer id (off-session) or a one-shot
   * payment method id (Stripe `pm_...`, Omise card token `tokn_...`).
   * For PromptPay: leave undefined — the gateway creates a source.
   */
  customerId?: string
  paymentMethodId?: string
  paymentMethodType: PaymentMethodType
  description?: string
  metadata?: Record<string, string>
  /**
   * Idempotency key to deduplicate retries from your code or your queue.
   * Both gateways respect the same header semantics (`Idempotency-Key`).
   */
  idempotencyKey?: string
}

/** Subscription creation input (card-based). */
export interface CreateSubscriptionInput {
  customerId: string
  /** Gateway-specific plan or price identifier. */
  planId: string
  /** Optional trial period in days. */
  trialDays?: number
  metadata?: Record<string, string>
}
