import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createHmac } from 'node:crypto'
import { OmiseGateway } from '../src/gateways/omise_gateway.ts'
import { PaymentError, WebhookVerificationError } from '../src/errors.ts'
import { calls, installFetchQueue, resetCalls, restoreFetch } from './_fetch_mock.ts'

const config = {
  secretKey: 'skey_test',
  webhookSecret: 'whsec_omise',
  baseUrl: 'https://omise.test',
}

beforeEach(() => {
  resetCalls()
})

afterEach(() => {
  restoreFetch()
})

describe('OmiseGateway.createCustomer', () => {
  test('POSTs /customers with Basic auth + form-encoded body', async () => {
    installFetchQueue([
      Response.json({ id: 'cust_1', email: 'a@b.test', description: 'Alice' }),
    ])
    const g = new OmiseGateway(config)

    const customer = await g.createCustomer({ email: 'a@b.test', name: 'Alice' })

    expect(customer.id).toBe('cust_1')
    expect(customer.name).toBe('Alice')
    expect(calls[0]!.url).toBe('https://omise.test/customers')
    expect(calls[0]!.headers.authorization).toMatch(/^Basic /)
    expect(calls[0]!.headers['content-type']).toBe('application/x-www-form-urlencoded')
    expect(calls[0]!.body).toMatchObject({ email: 'a@b.test', description: 'Alice' })
  })
})

describe('OmiseGateway.charge — PromptPay', () => {
  test('creates source then charge, returns requires_action with QR URL', async () => {
    installFetchQueue([
      // /sources response — carries the QR download URI
      Response.json({
        id: 'src_pp_1',
        type: 'promptpay',
        scannable_code: { type: 'barcode', image: { id: 'imgid', download_uri: 'https://omise.test/qr.png' } },
      }),
      // /charges response — pending
      Response.json({ id: 'chrg_1', status: 'pending', amount: 89000, currency: 'thb' }),
    ])
    const g = new OmiseGateway(config)

    const charge = await g.charge({
      amount: 89000,
      currency: 'thb',
      paymentMethodType: 'promptpay',
    })

    expect(charge.status).toBe('requires_action')
    expect(charge.nextAction?.type).toBe('promptpay_display_qr')
    expect(charge.nextAction?.imageUrl).toBe('https://omise.test/qr.png')
    expect(calls).toHaveLength(2)
    expect(calls[0]!.url).toBe('https://omise.test/sources')
    expect(calls[0]!.body).toMatchObject({ type: 'promptpay', amount: '89000', currency: 'thb' })
    expect(calls[1]!.body).toMatchObject({ source: 'src_pp_1', amount: '89000', currency: 'thb' })
  })

  test('rejects non-THB currency', async () => {
    installFetchQueue([])
    const g = new OmiseGateway(config)
    await expect(
      g.charge({ amount: 100, currency: 'usd', paymentMethodType: 'promptpay' })
    ).rejects.toThrow('PromptPay only supports THB')
  })
})

describe('OmiseGateway.charge — card', () => {
  test('POSTs /charges with customer for off-session card', async () => {
    installFetchQueue([
      Response.json({ id: 'chrg_2', status: 'successful', amount: 39000, currency: 'thb', customer: 'cust_1' }),
    ])
    const g = new OmiseGateway(config)

    const charge = await g.charge({
      amount: 39000,
      currency: 'thb',
      customerId: 'cust_1',
      paymentMethodType: 'card',
      idempotencyKey: 'idem-1',
    })

    expect(charge.status).toBe('succeeded')
    expect(charge.customerId).toBe('cust_1')
    expect(calls[0]!.headers['idempotency-key']).toBe('idem-1')
    expect(calls[0]!.body).toMatchObject({ amount: '39000', currency: 'thb', customer: 'cust_1' })
  })

  test('requires customerId or paymentMethodId', async () => {
    installFetchQueue([])
    const g = new OmiseGateway(config)
    await expect(
      g.charge({ amount: 100, currency: 'thb', paymentMethodType: 'card' })
    ).rejects.toThrow('customerId')
  })

  test('surfaces Omise error message', async () => {
    installFetchQueue([
      new Response(JSON.stringify({ code: 'invalid_card', message: 'card declined' }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      }),
    ])
    const g = new OmiseGateway(config)
    await expect(
      g.charge({ amount: 100, currency: 'thb', customerId: 'cust', paymentMethodType: 'card' })
    ).rejects.toThrow('card declined')
  })
})

describe('OmiseGateway.createSubscription', () => {
  test('POSTs /schedules with charge[customer] and decoded planId', async () => {
    installFetchQueue([
      Response.json({
        id: 'schd_1',
        status: 'running',
        every: 1,
        period: 'month',
        start_date: '2026-05-25',
        charge: { amount: 89000, currency: 'thb', customer: 'cust_1' },
      }),
    ])
    const g = new OmiseGateway(config)

    const sub = await g.createSubscription({ customerId: 'cust_1', planId: 'monthly:89000:thb' })

    expect(sub.status).toBe('active')
    expect(sub.customerId).toBe('cust_1')
    expect(sub.planId).toBe('monthly:89000:thb')
    expect(calls[0]!.body).toMatchObject({
      every: '1',
      period: 'month',
      'charge[amount]': '89000',
      'charge[currency]': 'thb',
      'charge[customer]': 'cust_1',
    })
  })

  test('rejects an unparseable planId', async () => {
    installFetchQueue([])
    const g = new OmiseGateway(config)
    await expect(
      g.createSubscription({ customerId: 'cust', planId: 'bad-plan-id' })
    ).rejects.toThrow('planId must encode')
  })
})

describe('OmiseGateway.verifyWebhook', () => {
  function sign(body: string): string {
    return createHmac('sha256', 'whsec_omise').update(body).digest('hex')
  }

  test('accepts a valid signature and maps charge.complete → charge.succeeded', () => {
    const body = JSON.stringify({
      id: 'evnt_1',
      key: 'charge.complete',
      data: { id: 'chrg_5', status: 'successful', amount: 100, currency: 'thb' },
    })
    const g = new OmiseGateway(config)
    const event = g.verifyWebhook({ 'x-opn-signature': `sha256=${sign(body)}` }, body)
    expect(event.type).toBe('charge.succeeded')
    expect(event.id).toBe('evnt_1')
    expect((event.resource as { id: string }).id).toBe('chrg_5')
  })

  test('rejects a tampered body', () => {
    const original = JSON.stringify({ id: 'e', key: 'charge.complete', data: { id: 'c', status: 'successful', amount: 1, currency: 'thb' } })
    const tampered = original.replace('"amount":1', '"amount":99999')
    const g = new OmiseGateway(config)
    expect(() => g.verifyWebhook({ 'x-opn-signature': sign(original) }, tampered)).toThrow(
      WebhookVerificationError
    )
  })

  test('rejects missing signature header', () => {
    const g = new OmiseGateway(config)
    expect(() => g.verifyWebhook({}, '{}')).toThrow('missing signature header')
  })

  test('throws when webhookSecret was not configured', () => {
    const g = new OmiseGateway({ secretKey: 'k' })
    expect(() => g.verifyWebhook({ 'x-opn-signature': 'x' }, '{}')).toThrow(
      'webhookSecret is not configured'
    )
  })

  test('maps schedule_occurrence.complete → subscription.renewed', () => {
    const body = JSON.stringify({
      id: 'evnt_2',
      key: 'schedule_occurrence.complete',
      data: { id: 'schd_1', status: 'running', charge: { customer: 'cust_x', amount: 89000, currency: 'thb' }, period: 'month' },
    })
    const g = new OmiseGateway(config)
    const event = g.verifyWebhook({ 'x-opn-signature': sign(body) }, body)
    expect(event.type).toBe('subscription.renewed')
  })
})
