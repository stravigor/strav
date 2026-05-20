import { describe, it, expect, beforeEach } from 'bun:test'
import Ledger from '../src/ledger/ledger.ts'
import { bootStripe } from './helpers.ts'

function ledgerRow(overrides: Partial<Record<string, unknown>> = {}) {
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

describe('Ledger', () => {
  let boot: ReturnType<typeof bootStripe>

  beforeEach(() => {
    boot = bootStripe()
  })

  describe('record', () => {
    it('inserts a charge entry with all required fields', async () => {
      boot.setResult([ledgerRow()])

      const entry = await Ledger.record({
        user: 1,
        entryType: 'charge',
        direction: 'debit',
        amount: 2500,
        currency: 'usd',
        stripeIntentId: 'pi_test123',
      })

      expect(entry.id).toBe(1)
      expect(entry.entryType).toBe('charge')
      expect(entry.direction).toBe('debit')
      expect(entry.amount).toBe(2500)
      expect(entry.stripeIntentId).toBe('pi_test123')

      const call = boot.calls.find(c => c.type === 'unsafe' && c.sql.includes('INSERT'))
      expect(call).toBeDefined()
      expect(call?.sql).toContain('strav_stripe_ledger')
      expect(call?.params[0]).toBe('1') // extractUserId stringifies
      expect(call?.params[1]).toBe('charge')
      expect(call?.params[2]).toBe('debit')
      expect(call?.params[3]).toBe(2500)
    })

    it('defaults currency from config when omitted', async () => {
      boot.setResult([ledgerRow()])

      await Ledger.record({
        user: 1,
        entryType: 'refund',
        direction: 'credit',
        amount: 1000,
      })

      const call = boot.calls.find(c => c.type === 'unsafe' && c.sql.includes('INSERT'))
      expect(call?.params[4]).toBe('usd')
    })

    it('serializes metadata to JSON', async () => {
      boot.setResult([ledgerRow({ metadata: { source: 'webhook' } })])

      await Ledger.record({
        user: 1,
        entryType: 'transfer',
        direction: 'debit',
        amount: 500,
        metadata: { source: 'webhook' },
      })

      const call = boot.calls.find(c => c.type === 'unsafe' && c.sql.includes('INSERT'))
      expect(call?.params[11]).toBe('{"source":"webhook"}')
    })

    it('handles all entry types in the union', async () => {
      const types = [
        'charge',
        'refund',
        'transfer',
        'application_fee',
        'hold_authorized',
        'hold_released',
        'hold_refunded',
        'hold_expired',
        'payout',
        'dispute',
        'adjustment',
      ] as const

      for (const entryType of types) {
        boot.setResult([ledgerRow({ entry_type: entryType })])
        const entry = await Ledger.record({
          user: 1,
          entryType,
          direction: 'debit',
          amount: 100,
        })
        expect(entry.entryType).toBe(entryType)
      }
    })
  })

  describe('findByUser', () => {
    it('queries with default limit 100, newest first', async () => {
      boot.setResult([ledgerRow(), ledgerRow({ id: 2 })])

      const entries = await Ledger.findByUser(1)

      expect(entries.length).toBe(2)
      const call = boot.calls[boot.calls.length - 1]
      expect(call.sql).toContain('ORDER BY "created_at" DESC')
      expect(call.params).toContain(100)
    })

    it('filters by entryType when provided', async () => {
      boot.setResult([ledgerRow({ entry_type: 'refund' })])

      await Ledger.findByUser(1, { entryType: 'refund', limit: 25 })

      const call = boot.calls[boot.calls.length - 1]
      expect(call.sql).toContain('"entry_type" = $2')
      expect(call.params).toEqual(['1', 'refund', 25])
    })
  })

  describe('findByIntent', () => {
    it('returns all entries tied to a payment intent in chronological order', async () => {
      boot.setResult([
        ledgerRow({ id: 1, entry_type: 'charge' }),
        ledgerRow({ id: 2, entry_type: 'application_fee', direction: 'credit' }),
        ledgerRow({ id: 3, entry_type: 'transfer' }),
      ])

      const entries = await Ledger.findByIntent('pi_test123')

      expect(entries.length).toBe(3)
      expect(entries[0]!.entryType).toBe('charge')
      const call = boot.calls[boot.calls.length - 1]
      expect(call.sql).toContain('"stripe_intent_id"')
      expect(call.sql).toContain('ORDER BY "created_at" ASC')
    })
  })

  describe('findByHold', () => {
    it('returns all entries tied to a hold in chronological order', async () => {
      boot.setResult([
        ledgerRow({ id: 1, hold_id: 42, entry_type: 'hold_authorized' }),
        ledgerRow({ id: 2, hold_id: 42, entry_type: 'hold_released' }),
      ])

      const entries = await Ledger.findByHold(42)

      expect(entries.length).toBe(2)
      expect(entries[0]!.holdId).toBe(42)
      const call = boot.calls[boot.calls.length - 1]
      expect(call.sql).toContain('"hold_id"')
    })
  })

  describe('API contract', () => {
    it('exposes no update or delete methods (append-only by API)', () => {
      // Compile-time guarantee + sanity check; mutation only possible via DB
      // trigger bypass.
      expect((Ledger as any).update).toBeUndefined()
      expect((Ledger as any).delete).toBeUndefined()
      expect((Ledger as any).remove).toBeUndefined()
    })
  })
})
