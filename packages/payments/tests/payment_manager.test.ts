import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import PaymentManager from '../src/payment_manager.ts'
import { GatewayNotRegisteredError } from '../src/errors.ts'
import type { Gateway } from '../src/gateway.ts'
import type {
  Charge,
  CreateChargeInput,
  CreateCustomerInput,
  CreateSubscriptionInput,
  GatewayCustomer,
  SavedPaymentMethod,
  Subscription,
  WebhookEvent,
} from '../src/types.ts'

class FakeGateway implements Gateway {
  constructor(public readonly name: string) {}
  async createCustomer(_input: CreateCustomerInput): Promise<GatewayCustomer> {
    return { id: 'c', raw: {} }
  }
  async attachPaymentMethod(_c: string, _p: string): Promise<SavedPaymentMethod> {
    return { id: 'pm', type: 'card', raw: {} }
  }
  async charge(_input: CreateChargeInput): Promise<Charge> {
    return { id: 'ch', amount: 1, currency: 'thb', status: 'succeeded', raw: {} }
  }
  async createSubscription(_i: CreateSubscriptionInput): Promise<Subscription> {
    return { id: 's', customerId: 'c', status: 'active', planId: 'p', raw: {} }
  }
  async cancelSubscription(_id: string): Promise<Subscription> {
    return { id: 's', customerId: 'c', status: 'canceled', planId: 'p', raw: {} }
  }
  verifyWebhook(_h: Record<string, string>, _b: string | Buffer): WebhookEvent {
    return { type: 'unknown', id: 'evt', resource: null, raw: {} }
  }
}

beforeEach(() => {
  PaymentManager.reset()
})

afterEach(() => {
  PaymentManager.reset()
})

describe('PaymentManager', () => {
  test('register makes the first gateway the default', () => {
    const a = new FakeGateway('omise')
    PaymentManager.register(a)
    expect(PaymentManager.gateway()).toBe(a)
    expect(PaymentManager.gateway('omise')).toBe(a)
  })

  test('register does not overwrite the configured default with a later register', () => {
    PaymentManager.register(new FakeGateway('omise'))
    PaymentManager.register(new FakeGateway('stripe'))
    expect(PaymentManager.gateway().name).toBe('omise')
  })

  test('gateway(name) throws when unknown', () => {
    PaymentManager.register(new FakeGateway('omise'))
    expect(() => PaymentManager.gateway('stripe')).toThrow(GatewayNotRegisteredError)
  })

  test('setDefault switches the resolver', () => {
    PaymentManager.register(new FakeGateway('omise'))
    PaymentManager.register(new FakeGateway('stripe'))
    PaymentManager.setDefault('stripe')
    expect(PaymentManager.gateway().name).toBe('stripe')
  })

  test('setDefault throws on unknown gateway', () => {
    expect(() => PaymentManager.setDefault('nope')).toThrow(GatewayNotRegisteredError)
  })

  test('has reports membership', () => {
    PaymentManager.register(new FakeGateway('omise'))
    expect(PaymentManager.has('omise')).toBe(true)
    expect(PaymentManager.has('stripe')).toBe(false)
  })
})
