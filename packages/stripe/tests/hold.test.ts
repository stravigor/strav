import { describe, it, expect, beforeEach } from 'bun:test'
import Hold from '../src/hold/hold.ts'
import { HoldStateError } from '../src/errors.ts'
import {
  bootStripe,
  customerRow,
  holdRow,
  stripeCustomer,
  stripePaymentIntent,
  stripeTransfer,
} from './helpers.ts'

describe('Hold', () => {
  let boot: ReturnType<typeof bootStripe>

  beforeEach(() => {
    boot = bootStripe()
  })

  describe('create', () => {
    beforeEach(() => {
      boot.stripe.onCall(
        'paymentIntents.create',
        stripePaymentIntent({ id: 'pi_hold123', status: 'requires_capture' })
      )
    })

    it('creates a manual-capture PaymentIntent and a pending row', async () => {
      // 1: findByUser → customer; 2: INSERT hold (returning) ; 3: INSERT hold_event
      boot.setResult([customerRow()]) // findByUser for Customer
      // Successive results: use a queue-style approach by re-setting before each step.
      // Simpler: stub returns the *same* result for all calls; helper resets that
      // for the INSERT hold step.
      const hold = await (async () => {
        boot.setResult([customerRow()])
        // patch: after Customer findByUser, the next call is INSERT hold returning *
        const inFlight = Hold.create(1, {
          amount: 100000,
          paymentMethodId: 'pm_test',
          description: 'Milestone 1',
        })
        // The shared mock returns the same nextResult for every call. We're
        // exploiting the fact that hydrate only looks at hold columns; the
        // customer-shaped row works because hydrate reads keys by name.
        boot.setResult([holdRow({ status: 'pending', amount: 100000 })])
        return inFlight
      })()

      expect(hold.status).toBe('pending')
      expect(hold.amount).toBe(100000)

      const intentCall = boot.stripe.callsFor('paymentIntents.create')[0]
      const args = intentCall?.args[0] as any
      expect(args.amount).toBe(100000)
      expect(args.capture_method).toBe('manual')
      expect(args.confirm).toBe(true)
      expect(args.payment_method).toBe('pm_test')
      expect(args.metadata.strav_hold).toBe('true')
    })
  })

  describe('state machine', () => {
    it('allows pending → authorized', async () => {
      boot.setResult([holdRow({ status: 'pending' })])
      // recordEvent reads then updates then inserts event then re-reads
      // For this minimal mock, all four queries return the same shared result.
      // We just verify it doesn't throw a HoldStateError.
      await expect(
        Hold.recordEvent(1, 'authorized', 'payment_intent.amount_capturable_updated')
      ).resolves.toBeDefined()
    })

    it('rejects pending → released (must go via authorized)', async () => {
      boot.setResult([holdRow({ status: 'pending' })])
      // The `release` path needs more wiring (capture + transfer); we use
      // recordEvent to test the gate cleanly.
      await expect(Hold.recordEvent(1, 'released', 'illegal')).rejects.toThrow(HoldStateError)
    })

    it('rejects authorized → pending (backward transition)', async () => {
      boot.setResult([holdRow({ status: 'authorized' })])
      await expect(Hold.recordEvent(1, 'pending', 'illegal')).rejects.toThrow(HoldStateError)
    })

    it('rejects refunded → released (terminal state)', async () => {
      boot.setResult([holdRow({ status: 'refunded' })])
      await expect(Hold.recordEvent(1, 'released', 'illegal')).rejects.toThrow(HoldStateError)
    })

    it('rejects expired → released (terminal state)', async () => {
      boot.setResult([holdRow({ status: 'expired' })])
      await expect(Hold.recordEvent(1, 'released', 'illegal')).rejects.toThrow(HoldStateError)
    })

    it('allows released → refunded (full reversal)', async () => {
      boot.setResult([holdRow({ status: 'released' })])
      await expect(Hold.recordEvent(1, 'refunded', 'manual')).resolves.toBeDefined()
    })

    it('throws when hold does not exist', async () => {
      boot.setResult([])
      await expect(Hold.recordEvent(999, 'authorized', 'x')).rejects.toThrow(HoldStateError)
    })
  })

  describe('release', () => {
    beforeEach(() => {
      boot.stripe.onCall(
        'paymentIntents.capture',
        stripePaymentIntent({ id: 'pi_hold123', status: 'succeeded', latest_charge: 'ch_test' })
      )
      boot.stripe.onCall('transfers.create', stripeTransfer({ amount: 90000 }))
    })

    it('captures, transfers, and writes 3 ledger entries on full release with fee', async () => {
      boot.setResult([holdRow({ status: 'authorized', amount: 100000 })])

      const result = await Hold.release(1, {
        destination: 'acct_freelancer',
        applicationFeeAmount: 10000,
      })

      const captureCall = boot.stripe.callsFor('paymentIntents.capture')[0]
      expect(captureCall?.args[0]).toBe('pi_hold123')
      expect((captureCall?.args[1] as any).amount_to_capture).toBe(100000)

      const transferCall = boot.stripe.callsFor('transfers.create')[0]
      const tArgs = transferCall?.args[0] as any
      expect(tArgs.amount).toBe(90000) // 100000 - 10000 fee
      expect(tArgs.destination).toBe('acct_freelancer')
      expect(tArgs.source_transaction).toBe('ch_test')

      // 3 ledger INSERTs: charge, application_fee, transfer
      const ledgerInserts = boot.calls.filter(
        c => c.type === 'unsafe' && c.sql.includes('INSERT INTO "strav_stripe_ledger"')
      )
      expect(ledgerInserts.length).toBe(3)
      expect(ledgerInserts[0]?.params[1]).toBe('charge')
      expect(ledgerInserts[1]?.params[1]).toBe('application_fee')
      expect(ledgerInserts[2]?.params[1]).toBe('transfer')

      expect(result.status).toBe('authorized') // shared-mock quirk; final findById returns same row
    })

    it('skips the application_fee ledger entry when fee is 0', async () => {
      boot.setResult([holdRow({ status: 'authorized', amount: 50000 })])

      await Hold.release(1, { destination: 'acct_x', applicationFeeAmount: 0 })

      const ledgerInserts = boot.calls.filter(
        c => c.type === 'unsafe' && c.sql.includes('INSERT INTO "strav_stripe_ledger"')
      )
      expect(ledgerInserts.length).toBe(2) // charge + transfer only
      expect(ledgerInserts.map(c => c.params[1])).toEqual(['charge', 'transfer'])
    })

    it('supports partial capture via amountToCapture', async () => {
      boot.setResult([holdRow({ status: 'authorized', amount: 100000 })])

      await Hold.release(1, {
        destination: 'acct_x',
        amountToCapture: 60000,
        applicationFeeAmount: 5000,
      })

      const captureCall = boot.stripe.callsFor('paymentIntents.capture')[0]
      expect((captureCall?.args[1] as any).amount_to_capture).toBe(60000)

      const transferCall = boot.stripe.callsFor('transfers.create')[0]
      expect((transferCall?.args[0] as any).amount).toBe(55000) // 60000 - 5000
    })

    it('rejects release from pending', async () => {
      boot.setResult([holdRow({ status: 'pending' })])
      await expect(Hold.release(1, { destination: 'acct_x' })).rejects.toThrow(HoldStateError)
    })
  })

  describe('refund', () => {
    beforeEach(() => {
      boot.stripe.onCall('refunds.create', { id: 're_test', amount: 100000 })
    })

    it('refunds an authorized hold and writes a refund credit', async () => {
      boot.setResult([holdRow({ status: 'authorized', amount: 100000 })])

      await Hold.refund(1)

      const refundCall = boot.stripe.callsFor('refunds.create')[0]
      expect((refundCall?.args[0] as any).payment_intent).toBe('pi_hold123')

      const ledgerInsert = boot.calls.find(
        c => c.type === 'unsafe' && c.sql.includes('INSERT INTO "strav_stripe_ledger"')
      )
      expect(ledgerInsert?.params[1]).toBe('refund')
      expect(ledgerInsert?.params[2]).toBe('credit')
    })

    it('supports partial refund amount', async () => {
      boot.setResult([holdRow({ status: 'released', amount: 100000 })])

      await Hold.refund(1, 25000)

      const refundCall = boot.stripe.callsFor('refunds.create')[0]
      expect((refundCall?.args[0] as any).amount).toBe(25000)

      const ledgerInsert = boot.calls.find(
        c => c.type === 'unsafe' && c.sql.includes('INSERT INTO "strav_stripe_ledger"')
      )
      expect(ledgerInsert?.params[3]).toBe(25000) // amount column
    })
  })

  describe('cancel', () => {
    beforeEach(() => {
      boot.stripe.onCall('paymentIntents.cancel', stripePaymentIntent({ status: 'canceled' }))
    })

    it('cancels a pending authorization', async () => {
      boot.setResult([holdRow({ status: 'pending' })])

      await Hold.cancel(1)

      const cancelCall = boot.stripe.callsFor('paymentIntents.cancel')[0]
      expect(cancelCall?.args[0]).toBe('pi_hold123')

      const eventInsert = boot.calls.find(
        c => c.type === 'unsafe' && c.sql.includes('INSERT INTO "strav_stripe_hold_event"')
      )
      expect(eventInsert?.params[3]).toBe('expired') // to_status
    })

    it('rejects cancel from released', async () => {
      boot.setResult([holdRow({ status: 'released' })])
      await expect(Hold.cancel(1)).rejects.toThrow(HoldStateError)
    })
  })

  describe('queries', () => {
    it('findById returns null when missing', async () => {
      boot.setResult([])
      expect(await Hold.findById(999)).toBeNull()
    })

    it('findByUser filters by status when provided', async () => {
      boot.setResult([holdRow({ status: 'authorized' })])
      await Hold.findByUser(1, 'authorized')
      const call = boot.calls[boot.calls.length - 1]
      expect(call.sql).toContain('"status" = $2')
      expect(call.params).toEqual(['1', 'authorized'])
    })

    it('findByPaymentIntent looks up by Stripe intent id', async () => {
      boot.setResult([holdRow()])
      await Hold.findByPaymentIntent('pi_hold123')
      const call = boot.calls[boot.calls.length - 1]
      expect(call.sql).toContain('payment_intent_id')
    })
  })
})
