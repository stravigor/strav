import { mock } from 'bun:test'
import StripeManager from '../src/stripe_manager.ts'

// ---------------------------------------------------------------------------
// Mock Configuration
// ---------------------------------------------------------------------------

export function mockConfig(overrides: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = {
    stripe: {
      secret: 'sk_test_fake',
      key: 'pk_test_fake',
      webhookSecret: 'whsec_test_fake',
      currency: 'usd',
      userKey: 'id',
      urls: {
        success: 'http://localhost:3000/billing/success',
        cancel: 'http://localhost:3000/billing/cancel',
      },
      ...overrides,
    },
  }

  return {
    get(key: string, defaultValue?: unknown): unknown {
      const parts = key.split('.')
      let current: any = data
      for (const part of parts) {
        if (current === undefined || current === null) return defaultValue
        current = current[part]
      }
      return current !== undefined ? current : defaultValue
    },
    has(key: string): boolean {
      return this.get(key) !== undefined
    },
  } as any
}

// ---------------------------------------------------------------------------
// Mock Database (Bun.sql tagged template)
// ---------------------------------------------------------------------------

export interface MockSqlCall {
  type: 'tagged' | 'unsafe'
  sql: string
  params: unknown[]
}

export function mockDb() {
  const calls: MockSqlCall[] = []
  let nextResult: Record<string, unknown>[] = []

  function taggedTemplate(strings: TemplateStringsArray, ...values: unknown[]) {
    const sql = strings.join('$?')
    calls.push({ type: 'tagged', sql, params: values })
    return Promise.resolve(nextResult)
  }

  taggedTemplate.unsafe = (sql: string, params: unknown[] = []) => {
    calls.push({ type: 'unsafe', sql, params })
    return Promise.resolve(nextResult)
  }

  const db = { sql: taggedTemplate } as any

  return {
    db,
    calls,
    /** Set the rows that the next query will return. */
    setResult(rows: Record<string, unknown>[]) {
      nextResult = rows
    },
    /** Clear recorded calls. */
    reset() {
      calls.length = 0
      nextResult = []
    },
  }
}

// ---------------------------------------------------------------------------
// Mock Stripe SDK (object-level, not fetch-level)
// ---------------------------------------------------------------------------

export interface StripeMockCall {
  method: string
  args: unknown[]
}

/**
 * Creates a mock Stripe object that records calls and returns
 * preset responses. Replaces `StripeManager._stripe`.
 */
export function mockStripe() {
  const calls: StripeMockCall[] = []
  const responses = new Map<string, unknown>()

  function makeMethod(name: string) {
    return mock((...args: unknown[]) => {
      calls.push({ method: name, args })
      const result = responses.get(name)
      return Promise.resolve(result)
    })
  }

  const stripe = {
    customers: {
      create: makeMethod('customers.create'),
      update: makeMethod('customers.update'),
      retrieve: makeMethod('customers.retrieve'),
    },
    subscriptions: {
      create: makeMethod('subscriptions.create'),
      update: makeMethod('subscriptions.update'),
      cancel: makeMethod('subscriptions.cancel'),
      retrieve: makeMethod('subscriptions.retrieve'),
    },
    subscriptionItems: {
      create: makeMethod('subscriptionItems.create'),
      update: makeMethod('subscriptionItems.update'),
      del: makeMethod('subscriptionItems.del'),
      createUsageRecord: makeMethod('subscriptionItems.createUsageRecord'),
    },
    paymentIntents: {
      create: makeMethod('paymentIntents.create'),
      capture: makeMethod('paymentIntents.capture'),
      cancel: makeMethod('paymentIntents.cancel'),
      retrieve: makeMethod('paymentIntents.retrieve'),
    },
    accounts: {
      create: makeMethod('accounts.create'),
      retrieve: makeMethod('accounts.retrieve'),
      del: makeMethod('accounts.del'),
    },
    accountLinks: {
      create: makeMethod('accountLinks.create'),
    },
    transfers: {
      create: makeMethod('transfers.create'),
    },
    identity: {
      verificationSessions: {
        create: makeMethod('identity.verificationSessions.create'),
        retrieve: makeMethod('identity.verificationSessions.retrieve'),
        cancel: makeMethod('identity.verificationSessions.cancel'),
      },
    },
    paymentMethods: {
      list: makeMethod('paymentMethods.list'),
      retrieve: makeMethod('paymentMethods.retrieve'),
      attach: makeMethod('paymentMethods.attach'),
      detach: makeMethod('paymentMethods.detach'),
    },
    setupIntents: {
      create: makeMethod('setupIntents.create'),
    },
    invoices: {
      list: makeMethod('invoices.list'),
      retrieve: makeMethod('invoices.retrieve'),
      retrieveUpcoming: makeMethod('invoices.retrieveUpcoming'),
      voidInvoice: makeMethod('invoices.voidInvoice'),
    },
    checkout: {
      sessions: {
        create: makeMethod('checkout.sessions.create'),
      },
    },
    refunds: {
      create: makeMethod('refunds.create'),
    },
    billingPortal: {
      sessions: {
        create: makeMethod('billingPortal.sessions.create'),
      },
    },
    webhooks: {
      constructEvent: makeMethod('webhooks.constructEvent'),
      constructEventAsync: makeMethod('webhooks.constructEventAsync'),
    },
  }

  return {
    stripe: stripe as any,
    calls,
    /** Set the return value for a specific method. */
    onCall(method: string, result: unknown) {
      responses.set(method, result)
    },
    /** Get calls for a specific method. */
    callsFor(method: string) {
      return calls.filter(c => c.method === method)
    },
  }
}

// ---------------------------------------------------------------------------
// Bootstrap StripeManager with mocks
// ---------------------------------------------------------------------------

export function bootStripe(overrides: Record<string, unknown> = {}) {
  const { db, calls, setResult, reset } = mockDb()
  const config = mockConfig(overrides)

  // Reset and re-initialize (this sets _db, _config, _userFkColumn)
  StripeManager.reset()
  new StripeManager(db, config)

  // Replace the Stripe SDK with our mock
  const stripeMock = mockStripe()
  ;(StripeManager as any)._stripe = stripeMock.stripe

  return {
    db,
    calls,
    setResult,
    reset,
    stripe: stripeMock,
  }
}

// ---------------------------------------------------------------------------
// Stripe response fixtures
// ---------------------------------------------------------------------------

export function stripeCustomer(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'cus_test123',
    object: 'customer',
    email: null,
    metadata: { strav_user_id: '1' },
    invoice_settings: { default_payment_method: null },
    ...overrides,
  }
}

export function stripeSubscription(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'sub_test123',
    object: 'subscription',
    customer: 'cus_test123',
    status: 'active',
    current_period_end: Math.floor(Date.now() / 1000) + 30 * 86400,
    trial_end: null,
    cancel_at: null,
    canceled_at: null,
    metadata: { strav_name: 'default', strav_user_id: '1' },
    items: {
      data: [
        {
          id: 'si_test123',
          price: {
            id: 'price_test123',
            product: 'prod_test123',
          },
          quantity: 1,
        },
      ],
    },
    latest_invoice: null,
    pending_setup_intent: null,
    ...overrides,
  }
}

export function stripePaymentMethod(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'pm_test123',
    object: 'payment_method',
    type: 'card',
    card: { last4: '4242', brand: 'visa' },
    ...overrides,
  }
}

export function stripePaymentIntent(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'pi_test123',
    object: 'payment_intent',
    amount: 2500,
    currency: 'usd',
    status: 'succeeded',
    ...overrides,
  }
}

export function stripeCheckoutSession(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'cs_test123',
    object: 'checkout.session',
    url: 'https://checkout.stripe.com/pay/cs_test123',
    mode: 'payment',
    ...overrides,
  }
}

export function stripeSetupIntent(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'seti_test123',
    object: 'setup_intent',
    client_secret: 'seti_test123_secret_xxx',
    ...overrides,
  }
}

/** A local DB row matching the `customer` table. */
export function customerRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    user_id: 1,
    stripe_id: 'cus_test123',
    pm_type: null,
    pm_last_four: null,
    trial_ends_at: null,
    created_at: new Date('2025-01-01'),
    updated_at: new Date('2025-01-01'),
    ...overrides,
  }
}

/** A local DB row matching the `subscription` table. */
export function subscriptionRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    user_id: 1,
    name: 'default',
    stripe_id: 'sub_test123',
    stripe_status: 'active',
    stripe_price_id: 'price_test123',
    quantity: 1,
    trial_ends_at: null,
    ends_at: null,
    created_at: new Date('2025-01-01'),
    updated_at: new Date('2025-01-01'),
    ...overrides,
  }
}

/** A local DB row matching the `subscription_item` table. */
export function subscriptionItemRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    subscription_id: 1,
    stripe_id: 'si_test123',
    stripe_product_id: 'prod_test123',
    stripe_price_id: 'price_test123',
    quantity: 1,
    created_at: new Date('2025-01-01'),
    updated_at: new Date('2025-01-01'),
    ...overrides,
  }
}

/** A local DB row matching the `receipt` table. */
export function receiptRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    user_id: 1,
    stripe_id: 'pi_test123',
    amount: 2500,
    currency: 'usd',
    description: null,
    receipt_url: null,
    created_at: new Date('2025-01-01'),
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Marketplace fixtures (Connect, Hold, Ledger, Webhook dedup)
// ---------------------------------------------------------------------------

export function stripeAccount(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'acct_test123',
    object: 'account',
    type: 'express',
    country: 'US',
    charges_enabled: false,
    payouts_enabled: false,
    details_submitted: false,
    capabilities: { transfers: 'inactive', card_payments: 'inactive' },
    requirements: { disabled_reason: 'requirements.past_due' },
    metadata: { strav_user_id: '1' },
    ...overrides,
  }
}

export function stripeAccountLink(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    object: 'account_link',
    url: 'https://connect.stripe.com/setup/e/acct_test123/xxx',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    created: Math.floor(Date.now() / 1000),
    ...overrides,
  }
}

export function stripeTransfer(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'tr_test123',
    object: 'transfer',
    amount: 90000,
    currency: 'usd',
    destination: 'acct_test123',
    source_transaction: 'ch_test123',
    ...overrides,
  }
}

/** A local DB row matching the `strav_stripe_connect_account` table. */
export function connectAccountRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    user_id: 1,
    stripe_account_id: 'acct_test123',
    account_type: 'express',
    country: 'US',
    charges_enabled: false,
    payouts_enabled: false,
    details_submitted: false,
    capabilities: null,
    requirements: null,
    created_at: new Date('2025-01-01'),
    updated_at: new Date('2025-01-01'),
    ...overrides,
  }
}

/** A local DB row matching the `strav_stripe_hold` table. */
export function holdRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    user_id: 1,
    payment_intent_id: 'pi_hold123',
    amount: 100000,
    currency: 'usd',
    status: 'pending',
    destination_account_id: null,
    application_fee_amount: null,
    expires_at: null,
    metadata: null,
    created_at: new Date('2025-01-01'),
    updated_at: new Date('2025-01-01'),
    ...overrides,
  }
}

/** A local DB row matching the `strav_stripe_hold_event` table. */
export function holdEventRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    strav_stripe_hold_id: 1,
    event_type: 'authorized',
    from_status: 'pending',
    to_status: 'authorized',
    payload: null,
    created_at: new Date('2025-01-01'),
    ...overrides,
  }
}

/** A local DB row matching the `strav_stripe_ledger` table. */
export function ledgerRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    user_id: 1,
    entry_type: 'charge',
    direction: 'debit',
    amount: 2500,
    currency: 'usd',
    stripe_intent_id: 'pi_test123',
    stripe_charge_id: null,
    stripe_transfer_id: null,
    connect_account_id: null,
    hold_id: null,
    description: null,
    metadata: null,
    created_at: new Date('2025-01-01'),
    ...overrides,
  }
}

/** A local DB row matching the `strav_stripe_webhook_event` table. */
export function webhookEventRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    stripe_event_id: 'evt_test123',
    event_type: 'account.updated',
    processed_at: null,
    created_at: new Date('2025-01-01'),
    ...overrides,
  }
}

export function stripeIdentitySession(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'vs_test123',
    object: 'identity.verification_session',
    type: 'document',
    status: 'requires_input',
    url: 'https://verify.stripe.com/start/test_xxx',
    client_secret: 'vs_test123_secret_xxx',
    metadata: { strav_user_id: '1' },
    last_error: null,
    last_verification_report: null,
    ...overrides,
  }
}

/** A local DB row matching the `strav_stripe_identity_session` table. */
export function identitySessionRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    user_id: 1,
    stripe_session_id: 'vs_test123',
    type: 'document',
    status: 'requires_input',
    document_country: null,
    document_type: null,
    last_error_code: null,
    last_error_reason: null,
    verified_at: null,
    canceled_at: null,
    metadata: null,
    created_at: new Date('2025-01-01'),
    updated_at: new Date('2025-01-01'),
    ...overrides,
  }
}
