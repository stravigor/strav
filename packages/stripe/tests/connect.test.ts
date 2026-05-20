import { describe, it, expect, beforeEach } from 'bun:test'
import StripeConnect from '../src/connect/connect.ts'
import { ConnectNotConfiguredError } from '../src/errors.ts'
import {
  bootStripe,
  stripeAccount,
  stripeAccountLink,
  connectAccountRow,
} from './helpers.ts'

function enabledOverrides() {
  return {
    connect: {
      enabled: true,
      accountType: 'express',
      defaultCountry: 'US',
      defaultBusinessType: 'individual',
      refreshUrl: 'http://localhost:3000/billing/connect/refresh',
      returnUrl: 'http://localhost:3000/billing/connect/complete',
    },
  }
}

describe('StripeConnect', () => {
  describe('gating (connect.enabled = false)', () => {
    let boot: ReturnType<typeof bootStripe>

    beforeEach(() => {
      boot = bootStripe() // default config has connect.enabled = false
    })

    it('createAccount throws ConnectNotConfiguredError', async () => {
      await expect(StripeConnect.createAccount(1)).rejects.toThrow(ConnectNotConfiguredError)
    })

    it('createAccountLink throws ConnectNotConfiguredError', async () => {
      await expect(StripeConnect.createAccountLink('acct_x')).rejects.toThrow(
        ConnectNotConfiguredError
      )
    })

    it('getAccountStatus throws ConnectNotConfiguredError', async () => {
      await expect(StripeConnect.getAccountStatus('acct_x')).rejects.toThrow(
        ConnectNotConfiguredError
      )
    })

    it('findByUser does NOT throw (read-only mirror access allowed)', async () => {
      boot.setResult([])
      await expect(StripeConnect.findByUser(1)).resolves.toBeNull()
    })
  })

  describe('createAccount (enabled)', () => {
    let boot: ReturnType<typeof bootStripe>

    beforeEach(() => {
      boot = bootStripe(enabledOverrides())
      boot.stripe.onCall('accounts.create', stripeAccount())
    })

    it('calls stripe.accounts.create with config defaults', async () => {
      boot.setResult([connectAccountRow()])

      await StripeConnect.createAccount(1)

      const call = boot.stripe.callsFor('accounts.create')[0]
      expect(call).toBeDefined()
      const args = call?.args[0] as any
      expect(args.type).toBe('express')
      expect(args.country).toBe('US')
      expect(args.business_type).toBe('individual')
      expect(args.metadata.strav_user_id).toBe('1')
    })

    it('caller params override config defaults', async () => {
      boot.setResult([connectAccountRow({ country: 'GB', account_type: 'custom' })])

      await StripeConnect.createAccount(1, {
        type: 'custom',
        country: 'GB',
        email: 'a@b.com',
      })

      const args = boot.stripe.callsFor('accounts.create')[0]?.args[0] as any
      expect(args.type).toBe('custom')
      expect(args.country).toBe('GB')
      expect(args.email).toBe('a@b.com')
    })

    it('inserts a local mirror row', async () => {
      boot.setResult([connectAccountRow()])

      const acct = await StripeConnect.createAccount(1)

      const insertCall = boot.calls.find(c => c.type === 'unsafe' && c.sql.includes('INSERT'))
      expect(insertCall?.sql).toContain('strav_stripe_connect_account')
      expect(acct.stripeAccountId).toBe('acct_test123')
      expect(acct.accountType).toBe('express')
    })
  })

  describe('createAccountLink', () => {
    let boot: ReturnType<typeof bootStripe>

    beforeEach(() => {
      boot = bootStripe(enabledOverrides())
      boot.stripe.onCall('accountLinks.create', stripeAccountLink())
    })

    it('uses config URLs by default and account_onboarding type', async () => {
      const link = await StripeConnect.createAccountLink('acct_test123')

      const args = boot.stripe.callsFor('accountLinks.create')[0]?.args[0] as any
      expect(args.account).toBe('acct_test123')
      expect(args.refresh_url).toBe('http://localhost:3000/billing/connect/refresh')
      expect(args.return_url).toBe('http://localhost:3000/billing/connect/complete')
      expect(args.type).toBe('account_onboarding')
      expect(link.url).toContain('connect.stripe.com')
    })

    it('caller URLs override config', async () => {
      await StripeConnect.createAccountLink('acct_test123', {
        refreshUrl: 'https://custom/refresh',
        returnUrl: 'https://custom/return',
      })

      const args = boot.stripe.callsFor('accountLinks.create')[0]?.args[0] as any
      expect(args.refresh_url).toBe('https://custom/refresh')
      expect(args.return_url).toBe('https://custom/return')
    })
  })

  describe('getAccountStatus', () => {
    it('maps Stripe account fields to ConnectAccountStatus', async () => {
      const boot = bootStripe(enabledOverrides())
      boot.stripe.onCall(
        'accounts.retrieve',
        stripeAccount({ charges_enabled: true, payouts_enabled: true, details_submitted: true })
      )

      const status = await StripeConnect.getAccountStatus('acct_test123')

      expect(status.chargesEnabled).toBe(true)
      expect(status.payoutsEnabled).toBe(true)
      expect(status.detailsSubmitted).toBe(true)
      expect(status.capabilities).toBeDefined()
    })
  })

  describe('findByUser / findByStripeId', () => {
    let boot: ReturnType<typeof bootStripe>

    beforeEach(() => {
      boot = bootStripe(enabledOverrides())
    })

    it('returns null when no local row exists', async () => {
      boot.setResult([])
      expect(await StripeConnect.findByUser(1)).toBeNull()
      expect(await StripeConnect.findByStripeId('acct_none')).toBeNull()
    })

    it('hydrates a found row', async () => {
      boot.setResult([connectAccountRow({ charges_enabled: true })])
      const acct = await StripeConnect.findByUser(1)
      expect(acct?.stripeAccountId).toBe('acct_test123')
      expect(acct?.chargesEnabled).toBe(true)
    })
  })

  describe('syncFromStripe', () => {
    it('updates local row from a Stripe account payload', async () => {
      const boot = bootStripe(enabledOverrides())
      boot.setResult([])

      await StripeConnect.syncFromStripe(
        stripeAccount({ id: 'acct_test123', charges_enabled: true }) as any
      )

      const call = boot.calls[boot.calls.length - 1]
      expect(call.sql).toContain('UPDATE')
      expect(call.sql).toContain('strav_stripe_connect_account')
      expect(call.sql).toContain('stripe_account_id')
    })
  })

  describe('deleteByUser / deleteByStripeId', () => {
    it('deletes by user FK', async () => {
      const boot = bootStripe(enabledOverrides())
      boot.setResult([])
      await StripeConnect.deleteByUser(1)
      const call = boot.calls[boot.calls.length - 1]
      expect(call.sql).toContain('DELETE FROM "strav_stripe_connect_account"')
    })

    it('deletes by stripe account id', async () => {
      const boot = bootStripe(enabledOverrides())
      boot.setResult([])
      await StripeConnect.deleteByStripeId('acct_test123')
      const call = boot.calls[boot.calls.length - 1]
      expect(call.sql).toContain('DELETE FROM "strav_stripe_connect_account"')
      expect(call.sql).toContain('stripe_account_id')
    })
  })
})
