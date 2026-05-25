import type {
  Charge,
  CreateChargeInput,
  CreateCustomerInput,
  CreateSubscriptionInput,
  GatewayCustomer,
  SavedPaymentMethod,
  Subscription,
  WebhookEvent,
} from './types.ts'

/**
 * Gateway-agnostic payment adapter contract.
 *
 * Two adapters ship in @strav/payments: `OmiseGateway` and `StripeGateway`.
 * Apps can register their own under any string name (TrueMoney, 2C2P,
 * dummy fakes for testing) via `PaymentManager.register()`.
 *
 * Methods take normalized inputs (CreateChargeInput, etc.) and return
 * normalized outputs (Charge, Subscription, WebhookEvent). Gateway-
 * specific fields are preserved on the `.raw` field of every return
 * value so callers can drop down when they need provider-specific
 * details (e.g., Stripe's `latest_invoice.payment_intent.client_secret`).
 *
 * Why a single Gateway, not multiple sub-interfaces:
 *   - PromptPay and cards are both modeled via `charge()`. PromptPay
 *     returns status='requires_action' with `nextAction` carrying the QR
 *     URL; cards return status='succeeded' (or 'failed') directly.
 *   - Card-based recurring goes through `createSubscription()`.
 *     PromptPay-style recurring is app-driven: a scheduler fires
 *     `charge()` each cycle, the customer receives a new QR. The
 *     interface doesn't model this — your durable workflow does.
 */
export interface Gateway {
  readonly name: string

  // ── Customers ──────────────────────────────────────────────────────────

  createCustomer(input: CreateCustomerInput): Promise<GatewayCustomer>

  /**
   * Attach a payment method (typically a card tokenised by the client SDK)
   * to a customer so it can be charged later off-session.
   *
   * Returns the saved method record so the app can display the last4
   * to the user. PromptPay sources can't be saved — pass `card` only.
   */
  attachPaymentMethod(
    customerId: string,
    paymentMethodId: string
  ): Promise<SavedPaymentMethod>

  // ── Charges ────────────────────────────────────────────────────────────

  /**
   * Create a one-off charge.
   *
   * Card flow: pass `customerId` (off-session) or `paymentMethodId`
   * (one-shot) with `paymentMethodType: 'card'`. Returns Charge with
   * status `succeeded` on capture or `failed` on decline.
   *
   * PromptPay flow: pass `paymentMethodType: 'promptpay'` (no
   * customerId / no paymentMethodId). Returns Charge with status
   * `requires_action` and `nextAction.imageUrl` / `nextAction.payload`
   * carrying the QR. The charge settles asynchronously when the
   * customer scans — listen for `charge.succeeded` via webhooks.
   */
  charge(input: CreateChargeInput): Promise<Charge>

  // ── Subscriptions (card-only) ──────────────────────────────────────────

  /**
   * Create a card-based recurring subscription. The customer must
   * already have a default payment method attached.
   *
   * For PromptPay "subscriptions", do not call this — schedule
   * `charge()` calls yourself via `@strav/queue`, deliver each new QR
   * to the customer (see ./line/promptpay_helper.ts).
   */
  createSubscription(input: CreateSubscriptionInput): Promise<Subscription>

  /**
   * Cancel a card subscription. `atPeriodEnd: true` keeps the subscription
   * active until the current period ends (typical user-facing flow);
   * `false` cancels immediately.
   */
  cancelSubscription(
    subscriptionId: string,
    options?: { atPeriodEnd?: boolean }
  ): Promise<Subscription>

  // ── Webhooks ───────────────────────────────────────────────────────────

  /**
   * Verify an inbound webhook and normalize it into the canonical
   * WebhookEvent shape. Throws `WebhookVerificationError` if the
   * signature header is missing, malformed, or doesn't match.
   *
   * `rawBody` MUST be the exact bytes the gateway delivered (HMAC is
   * computed over them). Re-stringifying parsed JSON will break
   * verification — surface the raw body from your HTTP layer.
   */
  verifyWebhook(
    headers: Record<string, string>,
    rawBody: Buffer | string
  ): WebhookEvent
}
