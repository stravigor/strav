import { describe, test, expect, beforeEach } from 'bun:test'
import { BaseModel } from '@strav/database'
import { billable } from '../src/billable.ts'
import { bootStripe, identitySessionRow, stripeIdentitySession } from './helpers.ts'

class User extends billable(BaseModel) {
  declare id: number
}

function makeUser(id = 1): User {
  const u = new User()
  ;(u as any).id = id
  ;(u as any)._exists = true
  return u
}

describe('billable — identity verification', () => {
  let boot: ReturnType<typeof bootStripe>

  beforeEach(() => {
    boot = bootStripe()
  })

  describe('startIdentityVerification', () => {
    test('delegates to StripeIdentity.createVerificationSession', async () => {
      boot.stripe.onCall('identity.verificationSessions.create', stripeIdentitySession())
      boot.setResult([identitySessionRow()])

      const session = await makeUser().startIdentityVerification({
        returnUrl: 'https://app/done',
        metadata: { purpose: 'kyc' },
      })

      const args = boot.stripe.callsFor('identity.verificationSessions.create')[0]?.args[0] as any
      expect(args.type).toBe('document')
      expect(args.return_url).toBe('https://app/done')
      expect(args.metadata.purpose).toBe('kyc')
      expect(args.metadata.strav_user_id).toBe('1')

      expect(session.url).toContain('verify.stripe.com')
      expect(session.stripeSessionId).toBe('vs_test123')
    })
  })

  describe('identityVerifications', () => {
    test('returns the list ordered newest first', async () => {
      boot.setResult([identitySessionRow(), identitySessionRow({ id: 2 })])

      const list = await makeUser().identityVerifications()

      expect(list.length).toBe(2)
      const call = boot.calls[boot.calls.length - 1]
      expect(call.sql).toContain('strav_stripe_identity_session')
      expect(call.sql).toContain('ORDER BY "created_at" DESC')
    })
  })

  describe('latestIdentityVerification', () => {
    test('returns null when none exist', async () => {
      boot.setResult([])
      expect(await makeUser().latestIdentityVerification()).toBeNull()
    })

    test('returns the most-recent row', async () => {
      boot.setResult([identitySessionRow({ status: 'verified' })])
      const latest = await makeUser().latestIdentityVerification()
      expect(latest?.status).toBe('verified')
    })
  })

  describe('identityVerified', () => {
    test('returns true only when latest session is verified', async () => {
      boot.setResult([identitySessionRow({ status: 'verified' })])
      expect(await makeUser().identityVerified()).toBe(true)
    })

    test('returns false when latest is in another state', async () => {
      boot.setResult([identitySessionRow({ status: 'processing' })])
      expect(await makeUser().identityVerified()).toBe(false)
    })

    test('returns false when no session exists', async () => {
      boot.setResult([])
      expect(await makeUser().identityVerified()).toBe(false)
    })
  })
})
