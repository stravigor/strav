import { describe, it, expect, beforeEach } from 'bun:test'
import { stripeWebhook } from '../src/webhook.ts'
import { checkAndRecordEvent, markEventProcessed } from '../src/webhook/idempotency.ts'
import { bootStripe } from './helpers.ts'

function mockCtx(body: string, signature: string | null) {
  const headers = new Map<string, string>()
  if (signature) headers.set('stripe-signature', signature)
  return {
    request: { text: () => Promise.resolve(body) },
    header(name: string) {
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

describe('webhook idempotency', () => {
  describe('checkAndRecordEvent', () => {
    let boot: ReturnType<typeof bootStripe>

    beforeEach(() => {
      boot = bootStripe()
    })

    it('returns true when ON CONFLICT inserts a new row', async () => {
      boot.setResult([{ id: 1 }])
      const fresh = await checkAndRecordEvent('evt_new', 'account.updated')
      expect(fresh).toBe(true)

      const call = boot.calls[0]
      expect(call.sql).toContain('strav_stripe_webhook_event')
      expect(call.sql).toContain('ON CONFLICT')
      expect(call.params).toEqual(['evt_new', 'account.updated'])
    })

    it('returns false when ON CONFLICT skips a duplicate', async () => {
      boot.setResult([])
      const fresh = await checkAndRecordEvent('evt_dup', 'payout.paid')
      expect(fresh).toBe(false)
    })
  })

  describe('markEventProcessed', () => {
    it('updates processed_at to NOW()', async () => {
      const boot = bootStripe()
      boot.setResult([])
      await markEventProcessed('evt_test')
      const call = boot.calls[boot.calls.length - 1]
      expect(call.sql).toContain('UPDATE')
      expect(call.sql).toContain('processed_at')
      expect(call.sql).toContain('NOW()')
    })
  })

  describe('stripeWebhook({ idempotency: true })', () => {
    let boot: ReturnType<typeof bootStripe>

    beforeEach(() => {
      boot = bootStripe()
    })

    it('dispatches handlers on first delivery and marks processed', async () => {
      boot.stripe.onCall('webhooks.constructEventAsync', {
        id: 'evt_first',
        type: 'invoice.created',
        data: { object: { id: 'inv_x' } },
      })
      // dedup INSERT returns a row → fresh
      boot.setResult([{ id: 1 }])

      const handler = stripeWebhook({ idempotency: true })
      const res = await handler(mockCtx('{}', 'sig'))

      expect(res.status).toBe(200)
      const body = (await res.json()) as any
      expect(body.received).toBe(true)
      expect(body.duplicate).toBeUndefined()

      // Saw dedup INSERT then markEventProcessed UPDATE
      const insert = boot.calls.find(c => c.sql.includes('strav_stripe_webhook_event'))
      const update = boot.calls.find(c => c.sql.includes('UPDATE') && c.sql.includes('processed_at'))
      expect(insert).toBeDefined()
      expect(update).toBeDefined()
    })

    it('returns {duplicate: true} on second delivery without dispatching', async () => {
      boot.stripe.onCall('webhooks.constructEventAsync', {
        id: 'evt_dup',
        type: 'invoice.created',
        data: { object: { id: 'inv_x' } },
      })
      // dedup INSERT returns no rows → duplicate
      boot.setResult([])

      const handler = stripeWebhook({ idempotency: true })
      const res = await handler(mockCtx('{}', 'sig'))

      expect(res.status).toBe(200)
      const body = (await res.json()) as any
      expect(body.received).toBe(true)
      expect(body.duplicate).toBe(true)

      // No markEventProcessed UPDATE because we short-circuited
      const update = boot.calls.find(c => c.sql.includes('UPDATE') && c.sql.includes('processed_at'))
      expect(update).toBeUndefined()
    })

    it('respects config default (idempotency off) when option omitted', async () => {
      // Default config has webhook.idempotency = false
      boot.stripe.onCall('webhooks.constructEventAsync', {
        id: 'evt_no_dedup',
        type: 'invoice.created',
        data: { object: { id: 'inv_x' } },
      })
      boot.setResult([])

      const handler = stripeWebhook() // no options
      const res = await handler(mockCtx('{}', 'sig'))

      expect(res.status).toBe(200)
      // No webhook_event table touched
      const dedup = boot.calls.find(c => c.sql.includes('strav_stripe_webhook_event'))
      expect(dedup).toBeUndefined()
    })

    it('config webhook.idempotency=true enables dedup without explicit option', async () => {
      const b = bootStripe({ webhook: { idempotency: true } })
      b.stripe.onCall('webhooks.constructEventAsync', {
        id: 'evt_from_cfg',
        type: 'invoice.created',
        data: { object: {} },
      })
      b.setResult([{ id: 1 }])

      const handler = stripeWebhook()
      await handler(mockCtx('{}', 'sig'))

      const insert = b.calls.find(c => c.sql.includes('strav_stripe_webhook_event'))
      expect(insert).toBeDefined()
    })
  })
})
