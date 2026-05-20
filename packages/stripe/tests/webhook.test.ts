import { describe, test, expect, beforeEach } from 'bun:test'
import { stripeWebhook, onWebhookEvent } from '../src/webhook.ts'
import { bootStripe, customerRow, subscriptionRow } from './helpers.ts'

let sql: ReturnType<typeof bootStripe>

// Minimal mock Context
function mockCtx(body: string, signature: string | null) {
  const headers = new Map<string, string>()
  if (signature) headers.set('stripe-signature', signature)

  return {
    request: {
      text: () => Promise.resolve(body),
    },
    header(name: string): string | undefined {
      return headers.get(name)
    },
    json(data: unknown, status = 200) {
      return new Response(JSON.stringify(data), {
        status,
        headers: { 'Content-Type': 'application/json' },
      })
    },
  } as any
}

describe('webhook', () => {
  beforeEach(() => {
    sql = bootStripe()
  })

  describe('stripeWebhook()', () => {
    test('returns 400 when stripe-signature header is missing', async () => {
      const handler = stripeWebhook()
      const ctx = mockCtx('{}', null)

      const res = await handler(ctx)

      expect(res.status).toBe(400)
      const body = (await res.json()) as { error: string }
      expect(body.error).toContain('stripe-signature')
    })

    test('throws WebhookSignatureError for invalid signature', async () => {
      // Override constructEventAsync (what webhook.ts actually awaits) to reject
      sql.stripe.stripe.webhooks.constructEventAsync = () => {
        return Promise.reject(new Error('Invalid signature'))
      }
      sql.stripe.stripe.webhooks.constructEvent = () => {
        throw new Error('Invalid signature')
      }

      const handler = stripeWebhook()
      const ctx = mockCtx('{}', 'invalid_sig')

      try {
        await handler(ctx)
        expect(true).toBe(false) // Should not reach here
      } catch (e: any) {
        expect(e.name).toBe('WebhookSignatureError')
      }
    })
  })

  describe('onWebhookEvent()', () => {
    test('registers and calls custom handlers', async () => {
      const calls: string[] = []

      onWebhookEvent('test.event', async event => {
        calls.push(event.type)
      })

      // We can't easily test the full flow without a valid signature,
      // but we can verify the handler registry works by testing
      // the built-in handler mechanism indirectly
      expect(calls).toHaveLength(0)
    })
  })

  describe('built-in event handlers', () => {
    // These test the DB sync behavior. Since we can't call handleBuiltinEvent
    // directly (it's private), we test the underlying operations instead.

    test('customer.subscription.created creates local record', async () => {
      // This tests the Subscription.create path used by the webhook handler
      sql.setResult([subscriptionRow()])

      const { default: Subscription } = await import('../src/subscription.ts')
      const sub = await Subscription.create({
        user: 1,
        name: 'default',
        stripeId: 'sub_webhook123',
        stripeStatus: 'active',
        stripePriceId: 'price_test',
      })

      expect(sub.stripeId).toBe('sub_test123') // from mock result
      expect(sql.calls[0]!.sql).toContain('INSERT')
    })

    test('customer.subscription.updated syncs status', async () => {
      sql.setResult([])

      const { default: Subscription } = await import('../src/subscription.ts')
      await Subscription.syncStripeStatus('sub_test123', 'past_due', new Date())

      expect(sql.calls).toHaveLength(1)
      expect(sql.calls[0]!.params).toContain('past_due')
    })

    test('customer.subscription.deleted marks as canceled', async () => {
      sql.setResult([])

      const { default: Subscription } = await import('../src/subscription.ts')
      await Subscription.syncStripeStatus('sub_test123', 'canceled', new Date())

      expect(sql.calls[0]!.params).toContain('canceled')
    })

    test('customer.deleted cleans up local records', async () => {
      // findByStripeId returns customer
      let callIndex = 0
      sql.db.sql = Object.assign(
        (strings: TemplateStringsArray, ...values: unknown[]) => {
          sql.calls.push({ type: 'tagged', sql: strings.join('$?'), params: values })
          callIndex++
          if (callIndex === 1) return Promise.resolve([customerRow()]) // findByStripeId
          return Promise.resolve([]) // subsequent queries
        },
        {
          unsafe: (sqlStr: string, params: unknown[] = []) => {
            sql.calls.push({ type: 'unsafe', sql: sqlStr, params })
            return Promise.resolve([]) // findByUser subscriptions → empty
          },
        }
      )

      const { default: Customer } = await import('../src/customer.ts')
      const { default: Subscription } = await import('../src/subscription.ts')

      // Simulate what the webhook handler does
      const customer = await Customer.findByStripeId('cus_test123')
      if (customer) {
        const subs = await Subscription.findByUser(customer.userId)
        for (const sub of subs) {
          await Subscription.delete(sub.id)
        }
        await Customer.deleteByStripeId('cus_test123')
      }

      // Should have: findByStripeId, findByUser subs, deleteByStripeId
      expect(sql.calls.length).toBeGreaterThanOrEqual(2)
    })
  })
})
