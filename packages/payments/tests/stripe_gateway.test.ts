import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { StripeGateway } from '../src/gateways/stripe_gateway.ts'
import { PaymentError, WebhookVerificationError } from '../src/errors.ts'
import { calls, installFetchQueue, resetCalls, restoreFetch } from './_fetch_mock.ts'

const config = {
  secretKey: 'sk_test_123',
  webhookSecret: 'whsec_stripe',
  baseUrl: 'https://stripe.test',
  defaultReturnUrl: 'https://app.example.com/return',
}

beforeEach(() => {
  resetCalls()
})

afterEach(() => {
  restoreFetch()
})

describe('StripeGateway.createCustomer', () => {
  test('POSTs /v1/customers with Bearer auth', async () => {
    installFetchQueue([Response.json({ id: 'cus_1', email: 'a@b.test', name: 'Alice' })])
    const g = new StripeGateway(config)

    const customer = await g.createCustomer({ email: 'a@b.test', name: 'Alice' })

    expect(customer.id).toBe('cus_1')
    expect(calls[0]!.headers.authorization).toBe('Bearer sk_test_123')
    expect(calls[0]!.headers['stripe-version']).toBeDefined()
    expect(calls[0]!.body).toMatchObject({ email: 'a@b.test', name: 'Alice' })
  })
})

describe('StripeGateway.charge — PromptPay', () => {
  test('creates a PaymentIntent with promptpay and surfaces the QR via nextAction', async () => {
    installFetchQueue([
      Response.json({
        id: 'pi_1',
        amount: 89000,
        currency: 'thb',
        status: 'requires_action',
        next_action: {
          type: 'promptpay_display_qr_code',
          promptpay_display_qr_code: {
            data: '00020101021229370016A000000677010111...',
            image_url_png: 'https://q.stripe.test/qr.png',
            image_url_svg: 'https://q.stripe.test/qr.svg',
          },
        },
      }),
    ])
    const g = new StripeGateway(config)

    const charge = await g.charge({
      amount: 89000,
      currency: 'thb',
      paymentMethodType: 'promptpay',
    })

    expect(charge.status).toBe('requires_action')
    expect(charge.nextAction?.imageUrl).toBe('https://q.stripe.test/qr.png')
    expect(charge.nextAction?.payload).toBe('00020101021229370016A000000677010111...')
    expect(calls[0]!.url).toBe('https://stripe.test/v1/payment_intents')
    expect(calls[0]!.body).toMatchObject({
      amount: '89000',
      currency: 'thb',
      'payment_method_types[]': 'promptpay',
      'payment_method_data[type]': 'promptpay',
      confirm: 'true',
      return_url: 'https://app.example.com/return',
    })
  })

  test('rejects non-THB PromptPay', async () => {
    installFetchQueue([])
    const g = new StripeGateway(config)
    await expect(
      g.charge({ amount: 100, currency: 'usd', paymentMethodType: 'promptpay' })
    ).rejects.toThrow('PromptPay only supports THB')
  })
})

describe('StripeGateway.charge — card', () => {
  test('off-session card with customer + payment_method', async () => {
    installFetchQueue([
      Response.json({ id: 'pi_2', amount: 100, currency: 'usd', status: 'succeeded', customer: 'cus_1' }),
    ])
    const g = new StripeGateway(config)

    const charge = await g.charge({
      amount: 100,
      currency: 'usd',
      customerId: 'cus_1',
      paymentMethodId: 'pm_1',
      paymentMethodType: 'card',
      idempotencyKey: 'idem-1',
    })

    expect(charge.status).toBe('succeeded')
    expect(calls[0]!.headers['idempotency-key']).toBe('idem-1')
    expect(calls[0]!.body).toMatchObject({
      'payment_method_types[]': 'card',
      customer: 'cus_1',
      payment_method: 'pm_1',
      off_session: 'true',
      confirm: 'true',
    })
  })
})

describe('StripeGateway.createSubscription', () => {
  test('POSTs /v1/subscriptions with items[0][price] from planId', async () => {
    installFetchQueue([
      Response.json({
        id: 'sub_1',
        status: 'active',
        customer: 'cus_1',
        current_period_start: 1716595200,
        current_period_end: 1719187200,
        items: { data: [{ price: { id: 'price_xxx' } }] },
      }),
    ])
    const g = new StripeGateway(config)

    const sub = await g.createSubscription({
      customerId: 'cus_1',
      planId: 'price_xxx',
      trialDays: 14,
    })

    expect(sub.status).toBe('active')
    expect(sub.planId).toBe('price_xxx')
    expect(calls[0]!.body).toMatchObject({
      customer: 'cus_1',
      'items[0][price]': 'price_xxx',
      trial_period_days: '14',
    })
  })
})

describe('StripeGateway.cancelSubscription', () => {
  test('atPeriodEnd: true → POSTs cancel_at_period_end', async () => {
    installFetchQueue([Response.json({ id: 'sub_1', status: 'active' })])
    const g = new StripeGateway(config)
    await g.cancelSubscription('sub_1', { atPeriodEnd: true })
    expect(calls[0]!.method).toBe('POST')
    expect(calls[0]!.body).toMatchObject({ cancel_at_period_end: 'true' })
  })

  test('immediate cancel → DELETE', async () => {
    installFetchQueue([Response.json({ id: 'sub_1', status: 'canceled' })])
    const g = new StripeGateway(config)
    const sub = await g.cancelSubscription('sub_1')
    expect(calls[0]!.method).toBe('DELETE')
    expect(sub.status).toBe('canceled')
  })
})

describe('StripeGateway.verifyWebhook', () => {
  function signedHeaders(body: string, timestamp = Math.floor(Date.now() / 1000)): Record<string, string> {
    const signedPayload = `${timestamp}.${body}`
    const v1 = createHmac('sha256', 'whsec_stripe').update(signedPayload).digest('hex')
    return { 'stripe-signature': `t=${timestamp},v1=${v1}` }
  }

  test('accepts a valid signature and maps payment_intent.succeeded → charge.succeeded', () => {
    const body = JSON.stringify({
      id: 'evt_1',
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_99', amount: 100, currency: 'thb', status: 'succeeded' } },
    })
    const g = new StripeGateway(config)
    const event = g.verifyWebhook(signedHeaders(body), body)
    expect(event.type).toBe('charge.succeeded')
    expect((event.resource as { id: string }).id).toBe('pi_99')
  })

  test('rejects out-of-tolerance timestamps (replay protection)', () => {
    const body = '{"id":"e","type":"x","data":{"object":{}}}'
    const old = Math.floor(Date.now() / 1000) - 600 // 10 minutes ago
    const g = new StripeGateway(config)
    expect(() => g.verifyWebhook(signedHeaders(body, old), body)).toThrow('tolerance')
  })

  test('rejects a tampered body', () => {
    const original = JSON.stringify({ id: 'evt', type: 'x', data: { object: {} } })
    const tampered = '{"id":"evt2","type":"x","data":{"object":{}}}'
    const g = new StripeGateway(config)
    expect(() => g.verifyWebhook(signedHeaders(original), tampered)).toThrow(
      WebhookVerificationError
    )
  })

  test('maps invoice.paid → subscription.renewed', () => {
    const body = JSON.stringify({
      id: 'evt_2',
      type: 'invoice.paid',
      data: { object: { id: 'in_1', subscription: 'sub_99', customer: 'cus_1' } },
    })
    const g = new StripeGateway(config)
    const event = g.verifyWebhook(signedHeaders(body), body)
    expect(event.type).toBe('subscription.renewed')
    expect((event.resource as { id: string }).id).toBe('sub_99')
  })

  test('throws when webhookSecret was not configured', () => {
    const g = new StripeGateway({ secretKey: 'k' })
    expect(() => g.verifyWebhook({ 'stripe-signature': 'x' }, '{}')).toThrow(
      'webhookSecret is not configured'
    )
  })
})
