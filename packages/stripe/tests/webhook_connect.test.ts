import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { Emitter } from '@strav/kernel'
import { stripeWebhook } from '../src/webhook.ts'
import { bootStripe, stripeAccount } from './helpers.ts'

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

describe('webhook — Connect events', () => {
  beforeEach(() => {
    Emitter.off()
  })

  afterEach(() => {
    Emitter.off()
  })

  describe('gating: connect.enabled = false (default)', () => {
    it('account.updated is a no-op (no DB write, no emit)', async () => {
      const boot = bootStripe()
      boot.stripe.onCall('webhooks.constructEventAsync', {
        id: 'evt_a',
        type: 'account.updated',
        data: { object: stripeAccount() },
      })

      const emitted: string[] = []
      Emitter.on('stripe:connect.account.updated', async () => {
        emitted.push('updated')
      })

      const handler = stripeWebhook()
      await handler(mockCtx('{}', 'sig'))

      expect(emitted).toEqual([])
      const updateCall = boot.calls.find(
        c => c.sql.includes('UPDATE') && c.sql.includes('strav_stripe_connect_account')
      )
      expect(updateCall).toBeUndefined()
    })

    it('payout.paid is a no-op when Connect disabled', async () => {
      const boot = bootStripe()
      boot.stripe.onCall('webhooks.constructEventAsync', {
        id: 'evt_p',
        type: 'payout.paid',
        account: 'acct_freelancer',
        data: { object: { id: 'po_x', amount: 1000, currency: 'usd' } },
      })

      const emitted: any[] = []
      Emitter.on('stripe:connect.payout.paid', async p => emitted.push(p))

      const handler = stripeWebhook()
      await handler(mockCtx('{}', 'sig'))

      expect(emitted).toEqual([])
    })
  })

  describe('with connect.enabled = true', () => {
    function enabledBoot() {
      return bootStripe({
        connect: {
          enabled: true,
          accountType: 'express',
          defaultCountry: 'US',
          defaultBusinessType: 'individual',
          refreshUrl: 'http://x/refresh',
          returnUrl: 'http://x/return',
        },
      })
    }

    it('account.updated syncs local mirror and emits event', async () => {
      const boot = enabledBoot()
      const acct = stripeAccount({ id: 'acct_x', charges_enabled: true })
      boot.stripe.onCall('webhooks.constructEventAsync', {
        id: 'evt_a',
        type: 'account.updated',
        data: { object: acct },
      })
      boot.setResult([])

      const emitted: any[] = []
      Emitter.on('stripe:connect.account.updated', async p => emitted.push(p))

      const handler = stripeWebhook()
      await handler(mockCtx('{}', 'sig'))

      const updateCall = boot.calls.find(
        c => c.sql.includes('UPDATE') && c.sql.includes('strav_stripe_connect_account')
      )
      expect(updateCall).toBeDefined()
      expect(emitted.length).toBe(1)
      expect(emitted[0].account.id).toBe('acct_x')
    })

    it('account.application.deauthorized deletes local row and emits event', async () => {
      const boot = enabledBoot()
      boot.stripe.onCall('webhooks.constructEventAsync', {
        id: 'evt_d',
        type: 'account.application.deauthorized',
        account: 'acct_dead',
        data: { object: { id: 'ca_app123', object: 'application' } },
      })
      boot.setResult([])

      const emitted: any[] = []
      Emitter.on('stripe:connect.account.deauthorized', async p => emitted.push(p))

      const handler = stripeWebhook()
      await handler(mockCtx('{}', 'sig'))

      const deleteCall = boot.calls.find(
        c => c.sql.includes('DELETE FROM "strav_stripe_connect_account"')
      )
      expect(deleteCall).toBeDefined()
      expect(emitted[0]?.accountId).toBe('acct_dead')
    })

    it('charge.dispute.created emits event', async () => {
      const boot = enabledBoot()
      const dispute = { id: 'dp_x', charge: 'ch_y', amount: 5000, currency: 'usd' }
      boot.stripe.onCall('webhooks.constructEventAsync', {
        id: 'evt_disp',
        type: 'charge.dispute.created',
        data: { object: dispute },
      })

      const emitted: any[] = []
      Emitter.on('stripe:dispute.created', async p => emitted.push(p))

      const handler = stripeWebhook()
      await handler(mockCtx('{}', 'sig'))

      expect(emitted.length).toBe(1)
      expect(emitted[0].dispute.id).toBe('dp_x')
    })
  })
})
