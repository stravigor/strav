import { describe, test, expect, beforeEach } from 'bun:test'
import { BaseModel } from '@strav/database'
import { billable } from '../src/billable.ts'
import {
  bootStripe,
  customerRow,
  holdRow,
  stripePaymentIntent,
  stripeTransfer,
} from './helpers.ts'

class User extends billable(BaseModel) {
  declare id: number
  declare email: string
}

function makeUser(id = 1): User {
  const u = new User()
  ;(u as any).id = id
  ;(u as any)._exists = true
  return u
}

describe('billable — marketplace methods', () => {
  let sql: ReturnType<typeof bootStripe>

  beforeEach(() => {
    sql = bootStripe()
  })

  describe('charge() with captureMethod', () => {
    test('default captureMethod=automatic preserves existing behavior', async () => {
      sql.setResult([customerRow()])
      sql.stripe.onCall('paymentIntents.create', stripePaymentIntent())

      await makeUser().charge(2500, 'pm_x')

      const args = sql.stripe.callsFor('paymentIntents.create')[0]?.args[0] as any
      expect(args.capture_method).toBeUndefined()
      expect(args.automatic_payment_methods?.enabled).toBe(true)
    })

    test('captureMethod=manual passes capture_method=manual and no auto_payment_methods', async () => {
      sql.setResult([customerRow()])
      sql.stripe.onCall(
        'paymentIntents.create',
        stripePaymentIntent({ status: 'requires_capture' })
      )

      await makeUser().charge(2500, 'pm_x', { captureMethod: 'manual' })

      const args = sql.stripe.callsFor('paymentIntents.create')[0]?.args[0] as any
      expect(args.capture_method).toBe('manual')
      expect(args.off_session).toBe(false)
      expect(args.automatic_payment_methods).toBeUndefined()
    })
  })

  describe('authorize / capture / cancelAuthorization', () => {
    test('authorize() is shorthand for charge() with manual capture', async () => {
      sql.setResult([customerRow()])
      sql.stripe.onCall(
        'paymentIntents.create',
        stripePaymentIntent({ status: 'requires_capture' })
      )

      await makeUser().authorize(5000, 'pm_x', { description: 'Hold' })

      const args = sql.stripe.callsFor('paymentIntents.create')[0]?.args[0] as any
      expect(args.capture_method).toBe('manual')
      expect(args.description).toBe('Hold')
    })

    test('capture() calls paymentIntents.capture with optional amount', async () => {
      sql.stripe.onCall('paymentIntents.capture', stripePaymentIntent({ status: 'succeeded' }))

      await makeUser().capture('pi_x')
      let call = sql.stripe.callsFor('paymentIntents.capture')[0]
      expect(call?.args[0]).toBe('pi_x')
      expect((call?.args[1] as any)?.amount_to_capture).toBeUndefined()

      await makeUser().capture('pi_x', 1500)
      call = sql.stripe.callsFor('paymentIntents.capture')[1]
      expect((call?.args[1] as any).amount_to_capture).toBe(1500)
    })

    test('cancelAuthorization() calls paymentIntents.cancel', async () => {
      sql.stripe.onCall('paymentIntents.cancel', stripePaymentIntent({ status: 'canceled' }))

      await makeUser().cancelAuthorization('pi_x')

      const call = sql.stripe.callsFor('paymentIntents.cancel')[0]
      expect(call?.args[0]).toBe('pi_x')
    })
  })

  describe('transferTo', () => {
    test('calls stripe.transfers.create with destination + default currency', async () => {
      sql.stripe.onCall('transfers.create', stripeTransfer())

      await makeUser().transferTo('acct_freelancer', 50000)

      const call = sql.stripe.callsFor('transfers.create')[0]
      const args = call?.args[0] as any
      expect(args.amount).toBe(50000)
      expect(args.destination).toBe('acct_freelancer')
      expect(args.currency).toBe('usd')
      expect(args.metadata.strav_user_id).toBe('1')
    })

    test('forwards source_transaction option', async () => {
      sql.stripe.onCall('transfers.create', stripeTransfer())

      await makeUser().transferTo('acct_x', 1000, 'eur', {
        sourceTransaction: 'ch_abc',
        description: 'Test',
      })

      const args = sql.stripe.callsFor('transfers.create')[0]?.args[0] as any
      expect(args.currency).toBe('eur')
      expect(args.source_transaction).toBe('ch_abc')
      expect(args.description).toBe('Test')
    })
  })

  describe('connectAccount / holds / ledger', () => {
    test('connectAccount() returns null when no local row', async () => {
      sql.setResult([])
      expect(await makeUser().connectAccount()).toBeNull()
    })

    test('holds() filters by status', async () => {
      sql.setResult([holdRow({ status: 'authorized' })])

      const holds = await makeUser().holds('authorized')

      expect(holds.length).toBe(1)
      const call = sql.calls[sql.calls.length - 1]
      expect(call.sql).toContain('"status" = $2')
    })

    test('ledger() reads append-only entries', async () => {
      sql.setResult([])
      await makeUser().ledger({ limit: 10 })
      const call = sql.calls[sql.calls.length - 1]
      expect(call.sql).toContain('strav_stripe_ledger')
      expect(call.params).toContain(10)
    })
  })

  describe('newHold', () => {
    test('delegates to Hold.create with the right shape', async () => {
      // 1: customer findByUser; 2: Stripe paymentIntents.create; 3: INSERT hold returning; 4: INSERT hold_event
      sql.setResult([customerRow()])
      sql.stripe.onCall(
        'paymentIntents.create',
        stripePaymentIntent({ id: 'pi_hold', status: 'requires_capture' })
      )

      const inFlight = makeUser().newHold(100000, 'pm_x', { description: 'Milestone' })
      sql.setResult([holdRow({ amount: 100000 })])
      await inFlight

      const intentArgs = sql.stripe.callsFor('paymentIntents.create')[0]?.args[0] as any
      expect(intentArgs.capture_method).toBe('manual')
      expect(intentArgs.amount).toBe(100000)
      expect(intentArgs.metadata.strav_hold).toBe('true')
    })
  })
})
