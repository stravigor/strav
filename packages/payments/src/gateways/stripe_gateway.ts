import { createHmac, timingSafeEqual } from 'node:crypto'
import { PaymentError, WebhookVerificationError } from '../errors.ts'
import type { Gateway } from '../gateway.ts'
import type {
  Charge,
  CreateChargeInput,
  CreateCustomerInput,
  CreateSubscriptionInput,
  GatewayCustomer,
  SavedPaymentMethod,
  Subscription,
  WebhookEvent,
  ChargeStatus,
  SubscriptionStatus,
} from '../types.ts'

export interface StripeGatewayConfig {
  /** Stripe secret key (sk_test_… or sk_live_…). */
  secretKey: string
  /**
   * Webhook signing secret (whsec_…) for verifying inbound webhook
   * deliveries. Configured per-endpoint in the Stripe dashboard.
   */
  webhookSecret?: string
  /** Pin the Stripe API version. Default: '2024-12-18.acacia'. */
  apiVersion?: string
  /** Override the API host. Default: 'https://api.stripe.com'. */
  baseUrl?: string
  /** Override the webhook timestamp tolerance in seconds. Default: 300 (5 min). */
  webhookToleranceSeconds?: number
  /**
   * Required for PaymentIntents that may surface a redirect-style
   * action — including PromptPay (the QR is hosted via Stripe). The
   * customer is redirected here after they pay (or after the QR expires).
   */
  defaultReturnUrl?: string
}

/**
 * Stripe gateway adapter.
 *
 * Card flow: standard PaymentIntents + Subscriptions. Saved
 * PaymentMethods can be charged off-session for recurring.
 *
 * PromptPay flow: PaymentIntent with `payment_method_types=['promptpay']`,
 * currency `thb`, requires a **Stripe TH account** (payouts must settle
 * to a Thai bank account). Returns a `requires_action` charge with
 * `nextAction.imageUrl` (`image_url_png`) and `nextAction.payload`
 * (the EMV-QR data string) so the app can render it natively or send
 * the hosted PNG.
 *
 * @see https://stripe.com/docs/payments/promptpay
 * @see https://stripe.com/docs/api/payment_intents
 */
export class StripeGateway implements Gateway {
  readonly name = 'stripe'
  private readonly secretKey: string
  private readonly webhookSecret?: string
  private readonly apiVersion: string
  private readonly baseUrl: string
  private readonly tolerance: number
  private readonly defaultReturnUrl?: string

  constructor(config: StripeGatewayConfig) {
    if (!config.secretKey) throw new PaymentError('stripe', 'secretKey is required')
    this.secretKey = config.secretKey
    this.webhookSecret = config.webhookSecret
    this.apiVersion = config.apiVersion ?? '2024-12-18.acacia'
    this.baseUrl = (config.baseUrl ?? 'https://api.stripe.com').replace(/\/$/, '')
    this.tolerance = config.webhookToleranceSeconds ?? 300
    this.defaultReturnUrl = config.defaultReturnUrl
  }

  // ── Customers ──────────────────────────────────────────────────────────

  async createCustomer(input: CreateCustomerInput): Promise<GatewayCustomer> {
    const raw = (await this.form('POST', '/v1/customers', {
      email: input.email,
      name: input.name,
      ...flattenMetadata(input.metadata),
    })) as { id: string; email?: string; name?: string }
    return { id: raw.id, email: raw.email, name: raw.name, metadata: input.metadata, raw }
  }

  async attachPaymentMethod(
    customerId: string,
    paymentMethodId: string
  ): Promise<SavedPaymentMethod> {
    const raw = (await this.form(
      'POST',
      `/v1/payment_methods/${encodeURIComponent(paymentMethodId)}/attach`,
      { customer: customerId }
    )) as StripePaymentMethodData
    // Also set as the customer's default for invoices so recurring
    // charges (Subscriptions) pick it up without an extra step.
    await this.form('POST', `/v1/customers/${encodeURIComponent(customerId)}`, {
      'invoice_settings[default_payment_method]': paymentMethodId,
    }).catch(() => undefined)

    if (raw.type !== 'card' || !raw.card) {
      // PromptPay sources can't be saved; if Stripe ever ships a
      // savable PromptPay, expand this branch.
      throw new PaymentError('stripe', 'attachPaymentMethod currently supports cards only')
    }
    return {
      id: raw.id,
      type: 'card',
      last4: raw.card.last4,
      brand: raw.card.brand,
      expMonth: raw.card.exp_month,
      expYear: raw.card.exp_year,
      raw,
    }
  }

  // ── Charges ────────────────────────────────────────────────────────────

  async charge(input: CreateChargeInput): Promise<Charge> {
    const body: Record<string, string | number | undefined> = {
      amount: input.amount,
      currency: input.currency,
      description: input.description,
      confirm: 'true',
      ...flattenMetadata(input.metadata),
    }

    if (input.paymentMethodType === 'promptpay') {
      if (input.currency.toLowerCase() !== 'thb') {
        throw new PaymentError('stripe', 'PromptPay only supports THB')
      }
      body['payment_method_types[]'] = 'promptpay'
      body['payment_method_data[type]'] = 'promptpay'
      if (this.defaultReturnUrl) body.return_url = this.defaultReturnUrl
    } else {
      body['payment_method_types[]'] = 'card'
      if (input.customerId) {
        body.customer = input.customerId
        body.off_session = 'true'
      }
      if (input.paymentMethodId) body.payment_method = input.paymentMethodId
    }

    const raw = (await this.form('POST', '/v1/payment_intents', body, {
      idempotencyKey: input.idempotencyKey,
    })) as StripePaymentIntentData
    return this.toCharge(raw)
  }

  // ── Subscriptions ──────────────────────────────────────────────────────

  async createSubscription(input: CreateSubscriptionInput): Promise<Subscription> {
    const body: Record<string, string | number | undefined> = {
      customer: input.customerId,
      'items[0][price]': input.planId,
      ...flattenMetadata(input.metadata),
    }
    if (input.trialDays) body.trial_period_days = input.trialDays
    const raw = (await this.form(
      'POST',
      '/v1/subscriptions',
      body
    )) as StripeSubscriptionData
    return this.toSubscription(raw, input.metadata)
  }

  async cancelSubscription(
    subscriptionId: string,
    options?: { atPeriodEnd?: boolean }
  ): Promise<Subscription> {
    if (options?.atPeriodEnd) {
      const raw = (await this.form(
        'POST',
        `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
        { cancel_at_period_end: 'true' }
      )) as StripeSubscriptionData
      return this.toSubscription(raw)
    }
    const raw = (await this.form(
      'DELETE',
      `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
      {}
    )) as StripeSubscriptionData
    return this.toSubscription(raw)
  }

  // ── Webhooks ───────────────────────────────────────────────────────────

  /**
   * Verify a Stripe webhook signature and parse the event.
   *
   * Stripe sends `Stripe-Signature: t=<timestamp>,v1=<hex_hmac>`. We
   * recompute HMAC-SHA256 over `<timestamp>.<body>` with the webhook
   * secret and compare with `v1` in constant time. Rejects timestamps
   * older than `webhookToleranceSeconds` to defeat replay.
   */
  verifyWebhook(headers: Record<string, string>, rawBody: Buffer | string): WebhookEvent {
    if (!this.webhookSecret) {
      throw new WebhookVerificationError(
        'stripe',
        'webhookSecret is not configured on the gateway'
      )
    }
    const header = pickHeader(headers, ['stripe-signature'])
    if (!header) throw new WebhookVerificationError('stripe', 'missing Stripe-Signature header')

    const parts = Object.fromEntries(
      header
        .split(',')
        .map(p => p.split('='))
        .filter(([k, v]) => k && v)
    )
    const timestamp = parts.t
    const signature = parts.v1
    if (!timestamp || !signature) {
      throw new WebhookVerificationError('stripe', 'malformed Stripe-Signature header')
    }
    const tsNum = Number(timestamp)
    if (!Number.isFinite(tsNum)) {
      throw new WebhookVerificationError('stripe', 'invalid timestamp')
    }
    const ageSeconds = Math.abs(Math.floor(Date.now() / 1000) - tsNum)
    if (ageSeconds > this.tolerance) {
      throw new WebhookVerificationError(
        'stripe',
        `timestamp outside tolerance (${ageSeconds}s > ${this.tolerance}s)`
      )
    }

    const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf-8') : rawBody
    const signedPayload = Buffer.concat([Buffer.from(`${timestamp}.`, 'utf-8'), body])
    const expected = createHmac('sha256', this.webhookSecret)
      .update(signedPayload)
      .digest('hex')

    const a = Buffer.from(signature, 'hex')
    const b = Buffer.from(expected, 'hex')
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new WebhookVerificationError('stripe', 'signature mismatch')
    }

    const payload = JSON.parse(body.toString('utf-8')) as {
      id: string
      type: string
      data: { object: Record<string, unknown> }
    }
    return this.toWebhookEvent(payload)
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private toCharge(raw: StripePaymentIntentData): Charge {
    const status: ChargeStatus = mapPaymentIntentStatus(raw.status)
    const charge: Charge = {
      id: raw.id,
      amount: raw.amount,
      currency: raw.currency,
      status,
      customerId: typeof raw.customer === 'string' ? raw.customer : undefined,
      raw,
    }
    const qr = raw.next_action?.promptpay_display_qr_code
    if (qr) {
      charge.status = 'requires_action'
      charge.nextAction = {
        type: 'promptpay_display_qr',
        imageUrl: qr.image_url_png,
        payload: qr.data,
        expiresAt: qr.hosted_instructions_url
          ? undefined
          : raw.next_action?.expires_at
          ? new Date(raw.next_action.expires_at * 1000)
          : undefined,
      }
    }
    return charge
  }

  private toSubscription(
    raw: StripeSubscriptionData,
    metadata?: Record<string, string>
  ): Subscription {
    const status: SubscriptionStatus =
      raw.status === 'trialing' ||
      raw.status === 'active' ||
      raw.status === 'past_due' ||
      raw.status === 'canceled' ||
      raw.status === 'incomplete' ||
      raw.status === 'incomplete_expired'
        ? (raw.status as SubscriptionStatus)
        : 'incomplete'
    return {
      id: raw.id,
      customerId: String(raw.customer ?? ''),
      status,
      planId: raw.items?.data?.[0]?.price?.id ?? '',
      currentPeriodStart: raw.current_period_start
        ? new Date(raw.current_period_start * 1000)
        : undefined,
      currentPeriodEnd: raw.current_period_end
        ? new Date(raw.current_period_end * 1000)
        : undefined,
      cancelAt: raw.cancel_at ? new Date(raw.cancel_at * 1000) : undefined,
      metadata,
      raw,
    }
  }

  private toWebhookEvent(payload: {
    id: string
    type: string
    data: { object: Record<string, unknown> }
  }): WebhookEvent {
    const map: Record<string, WebhookEvent['type']> = {
      'payment_intent.succeeded': 'charge.succeeded',
      'payment_intent.payment_failed': 'charge.failed',
      'payment_intent.processing': 'charge.pending',
      'payment_intent.requires_action': 'charge.requires_action',
      'customer.subscription.created': 'subscription.created',
      'customer.subscription.deleted': 'subscription.canceled',
      'invoice.paid': 'subscription.renewed',
      'invoice.payment_failed': 'subscription.payment_failed',
    }
    const type = map[payload.type] ?? 'unknown'
    let resource: WebhookEvent['resource'] = null
    if (type.startsWith('charge.')) {
      resource = this.toCharge(payload.data.object as unknown as StripePaymentIntentData)
    } else if (type === 'subscription.created' || type === 'subscription.canceled') {
      resource = this.toSubscription(payload.data.object as unknown as StripeSubscriptionData)
    } else if (type === 'subscription.renewed' || type === 'subscription.payment_failed') {
      // `invoice.*` payloads have a `subscription` reference; we surface
      // the invoice object as raw and synthesise enough to identify the
      // subscription without a follow-up GET.
      const invoice = payload.data.object as unknown as { id: string; subscription?: string; customer?: string }
      resource = {
        id: invoice.subscription ?? invoice.id,
        customerId: invoice.customer ?? '',
        status: type === 'subscription.renewed' ? 'active' : 'past_due',
        planId: '',
        raw: invoice,
      }
    }
    return { type, id: payload.id, resource, raw: payload }
  }

  private async form(
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body: Record<string, string | number | undefined>,
    options?: { idempotencyKey?: string }
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.secretKey}`,
      'Stripe-Version': this.apiVersion,
    }
    if (method !== 'GET') {
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
    }
    if (options?.idempotencyKey) {
      headers['Idempotency-Key'] = options.idempotencyKey
    }
    const init: RequestInit = { method, headers }
    if (method !== 'GET') {
      init.body = encodeForm(body)
    }

    const url = `${this.baseUrl}${path}`
    const response = await fetch(url, init)
    const text = await response.text()
    const raw: unknown = text ? safeJson(text) : undefined
    if (!response.ok) {
      const err = ((raw as { error?: { message?: string; code?: string } })?.error) ?? {}
      throw new PaymentError('stripe', err.message ?? response.statusText, {
        status: response.status,
        code: err.code,
        raw,
      })
    }
    return raw
  }
}

// ── Wire types (subset) ────────────────────────────────────────────────────

interface StripePaymentIntentData {
  id: string
  amount: number
  currency: string
  status:
    | 'requires_payment_method'
    | 'requires_confirmation'
    | 'requires_action'
    | 'processing'
    | 'requires_capture'
    | 'canceled'
    | 'succeeded'
  customer?: string
  next_action?: {
    type?: string
    expires_at?: number
    promptpay_display_qr_code?: {
      data: string
      image_url_png: string
      image_url_svg?: string
      hosted_instructions_url?: string
    }
  }
}

interface StripePaymentMethodData {
  id: string
  type: string
  card?: { brand?: string; last4?: string; exp_month?: number; exp_year?: number }
}

interface StripeSubscriptionData {
  id: string
  status: string
  customer?: string
  current_period_start?: number
  current_period_end?: number
  cancel_at?: number
  items?: { data?: { price?: { id: string } }[] }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function mapPaymentIntentStatus(status: string): ChargeStatus {
  if (status === 'succeeded') return 'succeeded'
  if (status === 'requires_action' || status === 'requires_confirmation') return 'requires_action'
  if (status === 'processing') return 'pending'
  return 'failed'
}

function encodeForm(body: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(body)) {
    if (v === undefined) continue
    params.append(k, String(v))
  }
  return params.toString()
}

function flattenMetadata(metadata?: Record<string, string>): Record<string, string> {
  if (!metadata) return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(metadata)) {
    out[`metadata[${k}]`] = v
  }
  return out
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

function pickHeader(headers: Record<string, string>, names: string[]): string | undefined {
  const normalised: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) normalised[k.toLowerCase()] = v
  for (const name of names) {
    const v = normalised[name]
    if (v) return v
  }
  return undefined
}
