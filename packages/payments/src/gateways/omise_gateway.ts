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

export interface OmiseGatewayConfig {
  /** Omise (Opn Payments) secret key — server-side only, never expose. */
  secretKey: string
  /**
   * Shared secret used to verify webhook signatures. Configured in the
   * Opn Payments dashboard under Webhooks → Sign requests. Without this
   * `verifyWebhook` throws ConfigurationError.
   */
  webhookSecret?: string
  /** Override the API host. Default: 'https://api.omise.co'. */
  baseUrl?: string
}

/**
 * Omise (Opn Payments) gateway adapter.
 *
 * Surfaces both card and PromptPay flows through the unified Gateway
 * interface:
 *
 * - **Card one-off** — call `charge({ customerId, paymentMethodType:
 *   'card' })` after `attachPaymentMethod(customerId, tokenId)`. Returns
 *   Charge with status `succeeded` or `failed`.
 * - **PromptPay one-off** — call `charge({ amount, currency: 'thb',
 *   paymentMethodType: 'promptpay' })`. Returns Charge with status
 *   `requires_action` and `nextAction.imageUrl` carrying the QR's
 *   `download_uri`. The charge settles asynchronously when the customer
 *   scans (webhook `charge.complete` → CanonicalEventType
 *   `charge.succeeded`).
 * - **Card recurring** — call `createSubscription({ customerId, planId
 *   })` after the customer has a default card. Backed by Omise
 *   `/schedules`. PromptPay-style recurring is app-driven, see the
 *   package docs.
 *
 * Auth: HTTP Basic with `secretKey` as the username and an empty
 * password — Omise's documented scheme.
 *
 * @see https://docs.opn.ooo/
 */
export class OmiseGateway implements Gateway {
  readonly name = 'omise'
  private readonly secretKey: string
  private readonly webhookSecret?: string
  private readonly baseUrl: string

  constructor(config: OmiseGatewayConfig) {
    if (!config.secretKey) throw new PaymentError('omise', 'secretKey is required')
    this.secretKey = config.secretKey
    this.webhookSecret = config.webhookSecret
    this.baseUrl = (config.baseUrl ?? 'https://api.omise.co').replace(/\/$/, '')
  }

  // ── Customers ──────────────────────────────────────────────────────────

  async createCustomer(input: CreateCustomerInput): Promise<GatewayCustomer> {
    const raw = (await this.form('POST', '/customers', {
      email: input.email,
      description: input.name,
      ...flattenMetadata(input.metadata),
    })) as { id: string; email?: string; description?: string }
    return { id: raw.id, email: raw.email, name: raw.description, metadata: input.metadata, raw }
  }

  async attachPaymentMethod(
    customerId: string,
    paymentMethodId: string
  ): Promise<SavedPaymentMethod> {
    // Omise updates a customer with a card token: the token attaches as a
    // card on the customer record and becomes the default.
    const raw = (await this.form(
      'PATCH',
      `/customers/${encodeURIComponent(customerId)}`,
      { card: paymentMethodId }
    )) as {
      default_card?: string
      cards?: { data?: OmiseCardData[] }
    }
    const cardId = raw.default_card
    const card = raw.cards?.data?.find(c => c.id === cardId) ?? raw.cards?.data?.[0]
    if (!card) {
      throw new PaymentError('omise', 'no card returned after attach', { raw })
    }
    return {
      id: card.id,
      type: 'card',
      last4: card.last_digits,
      brand: card.brand?.toLowerCase(),
      expMonth: card.expiration_month,
      expYear: card.expiration_year,
      raw: card,
    }
  }

  // ── Charges ────────────────────────────────────────────────────────────

  async charge(input: CreateChargeInput): Promise<Charge> {
    if (input.paymentMethodType === 'promptpay') {
      return this.chargePromptPay(input)
    }
    return this.chargeCard(input)
  }

  private async chargeCard(input: CreateChargeInput): Promise<Charge> {
    if (!input.customerId && !input.paymentMethodId) {
      throw new PaymentError(
        'omise',
        'card charges require customerId (off-session) or paymentMethodId (one-shot)'
      )
    }
    const body: Record<string, string | number | undefined> = {
      amount: input.amount,
      currency: input.currency,
      description: input.description,
      ...flattenMetadata(input.metadata),
    }
    if (input.customerId) body.customer = input.customerId
    if (input.paymentMethodId) body.card = input.paymentMethodId

    const raw = (await this.form('POST', '/charges', body, {
      idempotencyKey: input.idempotencyKey,
    })) as OmiseChargeData
    return this.toCharge(raw)
  }

  private async chargePromptPay(input: CreateChargeInput): Promise<Charge> {
    if (input.currency.toLowerCase() !== 'thb') {
      throw new PaymentError('omise', 'PromptPay only supports THB')
    }
    // Two-step: create source, then charge.
    const source = (await this.form('POST', '/sources', {
      type: 'promptpay',
      amount: input.amount,
      currency: input.currency,
    })) as OmiseSourceData

    const raw = (await this.form(
      'POST',
      '/charges',
      {
        amount: input.amount,
        currency: input.currency,
        source: source.id,
        description: input.description,
        ...flattenMetadata(input.metadata),
      },
      { idempotencyKey: input.idempotencyKey }
    )) as OmiseChargeData

    const charge = this.toCharge(raw)
    const qrUrl = source.scannable_code?.image?.download_uri
    if (qrUrl) {
      charge.status = 'requires_action'
      charge.nextAction = {
        type: 'promptpay_display_qr',
        imageUrl: qrUrl,
        // Omise PromptPay sources stay valid for a few minutes; the exact
        // expiry isn't returned, so leave undefined.
      }
    }
    return charge
  }

  // ── Subscriptions ──────────────────────────────────────────────────────

  async createSubscription(input: CreateSubscriptionInput): Promise<Subscription> {
    // Omise models card-based recurring via /schedules. `planId` here is
    // the gateway-specific identifier the app uses to look up amount +
    // currency + period — schedules don't carry a server-side "plan"
    // concept the way Stripe does, so the app supplies them.
    const plan = parsePlanId(input.planId)
    if (!plan) {
      throw new PaymentError(
        'omise',
        'planId must encode the schedule, e.g. "monthly:39000:thb" (period:amountSatang:currency)'
      )
    }

    const raw = (await this.form('POST', '/schedules', {
      every: 1,
      period: plan.period,
      start_date: today(),
      'charge[amount]': plan.amount,
      'charge[currency]': plan.currency,
      'charge[customer]': input.customerId,
      'charge[description]': `Subscription ${input.planId}`,
    })) as OmiseScheduleData
    return this.toSubscription(raw, input.customerId, input.planId, input.metadata)
  }

  async cancelSubscription(
    subscriptionId: string,
    options?: { atPeriodEnd?: boolean }
  ): Promise<Subscription> {
    // Omise schedules don't have "cancel at period end" — they're either
    // active or destroyed. Honour atPeriodEnd by no-op-ing now and leaving
    // the schedule to expire on its own end_date if set; otherwise destroy.
    if (options?.atPeriodEnd) {
      const raw = (await this.form(
        'GET',
        `/schedules/${encodeURIComponent(subscriptionId)}`,
        {}
      )) as OmiseScheduleData
      return this.toSubscription(raw, raw.charge?.customer ?? '', encodePlan(raw))
    }
    const raw = (await this.form(
      'DELETE',
      `/schedules/${encodeURIComponent(subscriptionId)}`,
      {}
    )) as OmiseScheduleData
    return this.toSubscription(raw, raw.charge?.customer ?? '', encodePlan(raw))
  }

  // ── Webhooks ───────────────────────────────────────────────────────────

  verifyWebhook(headers: Record<string, string>, rawBody: Buffer | string): WebhookEvent {
    if (!this.webhookSecret) {
      throw new WebhookVerificationError(
        'omise',
        'webhookSecret is not configured on the gateway'
      )
    }
    // Modern Opn Payments delivers `X-Opn-Signature: sha256=<hex>`. Older
    // setups use `X-Omise-Signature`. Accept either.
    const header = pickHeader(headers, ['x-opn-signature', 'x-omise-signature'])
    if (!header) {
      throw new WebhookVerificationError('omise', 'missing signature header')
    }
    const provided = header.startsWith('sha256=') ? header.slice(7) : header
    const body = typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf-8') : rawBody
    const expected = createHmac('sha256', this.webhookSecret).update(body).digest('hex')

    const a = Buffer.from(provided, 'hex')
    const b = Buffer.from(expected, 'hex')
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new WebhookVerificationError('omise', 'signature mismatch')
    }

    const payload = JSON.parse(body.toString('utf-8')) as {
      id: string
      key: string
      data: Record<string, unknown>
    }
    return this.toWebhookEvent(payload)
  }

  // ── Internals ──────────────────────────────────────────────────────────

  private toCharge(raw: OmiseChargeData): Charge {
    const status: ChargeStatus =
      raw.status === 'successful'
        ? 'succeeded'
        : raw.status === 'failed'
        ? 'failed'
        : 'pending'
    return {
      id: raw.id,
      amount: raw.amount,
      currency: raw.currency,
      status,
      customerId: typeof raw.customer === 'string' ? raw.customer : undefined,
      raw,
    }
  }

  private toSubscription(
    raw: OmiseScheduleData,
    customerId: string,
    planId: string,
    metadata?: Record<string, string>
  ): Subscription {
    const status: SubscriptionStatus =
      raw.status === 'running'
        ? 'active'
        : raw.status === 'suspended'
        ? 'past_due'
        : raw.status === 'deleted' || raw.status === 'expiring'
        ? 'canceled'
        : 'incomplete'
    return {
      id: raw.id,
      customerId,
      status,
      planId,
      currentPeriodStart: raw.start_date ? new Date(raw.start_date) : undefined,
      currentPeriodEnd: raw.end_date ? new Date(raw.end_date) : undefined,
      metadata,
      raw,
    }
  }

  private toWebhookEvent(payload: {
    id: string
    key: string
    data: Record<string, unknown>
  }): WebhookEvent {
    const map: Record<string, WebhookEvent['type']> = {
      'charge.create': 'charge.pending',
      'charge.complete': 'charge.succeeded',
      'charge.failed': 'charge.failed',
      'charge.expired': 'charge.failed',
      'schedule.create': 'subscription.created',
      'schedule.destroy': 'subscription.canceled',
      'schedule.expiring': 'subscription.canceled',
      'schedule_occurrence.complete': 'subscription.renewed',
      'schedule_occurrence.failed': 'subscription.payment_failed',
    }
    const type = map[payload.key] ?? 'unknown'
    let resource: WebhookEvent['resource'] = null
    if (type.startsWith('charge.')) {
      resource = this.toCharge(payload.data as unknown as OmiseChargeData)
    } else if (type.startsWith('subscription.')) {
      const data = payload.data as unknown as OmiseScheduleData
      resource = this.toSubscription(data, data.charge?.customer ?? '', encodePlan(data))
    }
    return { type, id: payload.id, resource, raw: payload }
  }

  private async form(
    method: 'GET' | 'POST' | 'DELETE' | 'PATCH',
    path: string,
    body: Record<string, string | number | undefined>,
    options?: { idempotencyKey?: string }
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      Authorization: `Basic ${Buffer.from(`${this.secretKey}:`).toString('base64')}`,
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
      const err = (raw as { code?: string; message?: string }) ?? {}
      throw new PaymentError('omise', err.message ?? response.statusText, {
        status: response.status,
        code: err.code,
        raw,
      })
    }
    return raw
  }
}

// ── Wire types (subset) ────────────────────────────────────────────────────

interface OmiseChargeData {
  id: string
  status: 'pending' | 'successful' | 'failed' | 'expired' | 'reversed'
  amount: number
  currency: string
  customer?: string
  source?: { id: string; type: string }
}

interface OmiseSourceData {
  id: string
  type: string
  scannable_code?: { type: string; image?: { id: string; download_uri: string } }
}

interface OmiseCardData {
  id: string
  last_digits?: string
  brand?: string
  expiration_month?: number
  expiration_year?: number
}

interface OmiseScheduleData {
  id: string
  status: 'running' | 'expiring' | 'expired' | 'suspended' | 'deleted'
  every?: number
  period?: 'day' | 'week' | 'month'
  start_date?: string
  end_date?: string
  charge?: { amount?: number; currency?: string; customer?: string }
}

// ── Helpers ────────────────────────────────────────────────────────────────

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
  // Normalise to lowercase keys for case-insensitive lookup.
  const normalised: Record<string, string> = {}
  for (const [k, v] of Object.entries(headers)) normalised[k.toLowerCase()] = v
  for (const name of names) {
    const v = normalised[name]
    if (v) return v
  }
  return undefined
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function parsePlanId(
  planId: string
): { period: 'day' | 'week' | 'month'; amount: number; currency: string } | null {
  const match = /^(daily|weekly|monthly):(\d+):([a-zA-Z]{3})$/.exec(planId)
  if (!match) return null
  const periodMap = { daily: 'day', weekly: 'week', monthly: 'month' } as const
  return {
    period: periodMap[match[1] as keyof typeof periodMap],
    amount: Number(match[2]),
    currency: match[3]!.toLowerCase(),
  }
}

function encodePlan(schedule: OmiseScheduleData): string {
  const periodMap = { day: 'daily', week: 'weekly', month: 'monthly' } as const
  const p = schedule.period && periodMap[schedule.period as keyof typeof periodMap]
  return `${p ?? 'monthly'}:${schedule.charge?.amount ?? 0}:${(schedule.charge?.currency ?? 'thb').toLowerCase()}`
}
