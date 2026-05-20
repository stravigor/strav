import { describe, it, expect, beforeEach } from 'bun:test'
import StripeIdentity from '../src/identity/identity.ts'
import { bootStripe, stripeIdentitySession, identitySessionRow } from './helpers.ts'

describe('StripeIdentity', () => {
  let boot: ReturnType<typeof bootStripe>

  beforeEach(() => {
    boot = bootStripe()
  })

  describe('createVerificationSession', () => {
    beforeEach(() => {
      boot.stripe.onCall('identity.verificationSessions.create', stripeIdentitySession())
    })

    it('creates a Stripe session with type=document default + allowed_types fallback', async () => {
      boot.setResult([identitySessionRow()])

      const session = await StripeIdentity.createVerificationSession(1)

      const call = boot.stripe.callsFor('identity.verificationSessions.create')[0]
      const args = call?.args[0] as any
      expect(args.type).toBe('document')
      expect(args.options.document.allowed_types).toEqual([
        'driving_license',
        'passport',
        'id_card',
      ])
      expect(args.metadata.strav_user_id).toBe('1')

      expect(session.stripeSessionId).toBe('vs_test123')
      expect(session.url).toContain('verify.stripe.com')
      expect(session.clientSecret).toBeDefined()
    })

    it('forwards returnUrl and caller metadata', async () => {
      boot.setResult([identitySessionRow()])

      await StripeIdentity.createVerificationSession(1, {
        returnUrl: 'https://app/done',
        metadata: { purpose: 'high_value_post' },
      })

      const args = boot.stripe.callsFor('identity.verificationSessions.create')[0]?.args[0] as any
      expect(args.return_url).toBe('https://app/done')
      expect(args.metadata.purpose).toBe('high_value_post')
      expect(args.metadata.strav_user_id).toBe('1')
    })

    it('allows overriding the document allow-list', async () => {
      boot.setResult([identitySessionRow()])

      await StripeIdentity.createVerificationSession(1, {
        options: {
          document: {
            allowed_types: ['passport'],
            require_live_capture: true,
            require_matching_selfie: true,
          },
        },
      })

      const args = boot.stripe.callsFor('identity.verificationSessions.create')[0]?.args[0] as any
      expect(args.options.document.allowed_types).toEqual(['passport'])
      expect(args.options.document.require_live_capture).toBe(true)
    })

    it('skips document defaults when type=id_number', async () => {
      boot.stripe.onCall(
        'identity.verificationSessions.create',
        stripeIdentitySession({ type: 'id_number' })
      )
      boot.setResult([identitySessionRow({ type: 'id_number' })])

      await StripeIdentity.createVerificationSession(1, { type: 'id_number' })

      const args = boot.stripe.callsFor('identity.verificationSessions.create')[0]?.args[0] as any
      expect(args.type).toBe('id_number')
      expect(args.options.document).toBeUndefined()
    })

    it('inserts a local mirror row with status from Stripe', async () => {
      boot.setResult([identitySessionRow()])
      await StripeIdentity.createVerificationSession(1)

      const insertCall = boot.calls.find(
        c => c.type === 'unsafe' && c.sql.includes('INSERT')
      )
      expect(insertCall?.sql).toContain('strav_stripe_identity_session')
      expect(insertCall?.params[1]).toBe('vs_test123')
      expect(insertCall?.params[2]).toBe('document')
      expect(insertCall?.params[3]).toBe('requires_input')
    })
  })

  describe('getSessionStatus', () => {
    it('extracts status + document fields from a Stripe session', async () => {
      boot.stripe.onCall(
        'identity.verificationSessions.retrieve',
        stripeIdentitySession({
          status: 'verified',
          last_verification_report: {
            document: { issuing_country: 'US', type: 'passport' },
          },
        })
      )

      const status = await StripeIdentity.getSessionStatus('vs_test123')

      expect(status.status).toBe('verified')
      expect(status.documentCountry).toBe('US')
      expect(status.documentType).toBe('passport')
    })

    it('returns nulls when no verification report yet', async () => {
      boot.stripe.onCall('identity.verificationSessions.retrieve', stripeIdentitySession())
      const status = await StripeIdentity.getSessionStatus('vs_test123')
      expect(status.documentCountry).toBeNull()
      expect(status.documentType).toBeNull()
    })

    it('exposes last_error code/reason when present', async () => {
      boot.stripe.onCall(
        'identity.verificationSessions.retrieve',
        stripeIdentitySession({
          status: 'requires_input',
          last_error: { code: 'document_unverified_other', reason: 'Could not verify' },
        })
      )

      const status = await StripeIdentity.getSessionStatus('vs_test123')
      expect(status.lastErrorCode).toBe('document_unverified_other')
      expect(status.lastErrorReason).toBe('Could not verify')
    })
  })

  describe('cancelSession', () => {
    it('calls stripe.identity.verificationSessions.cancel', async () => {
      boot.stripe.onCall(
        'identity.verificationSessions.cancel',
        stripeIdentitySession({ status: 'canceled' })
      )
      await StripeIdentity.cancelSession('vs_test123')
      const call = boot.stripe.callsFor('identity.verificationSessions.cancel')[0]
      expect(call?.args[0]).toBe('vs_test123')
    })
  })

  describe('syncFromStripe', () => {
    it('updates status + sets verified_at when verified', async () => {
      boot.setResult([])

      await StripeIdentity.syncFromStripe(
        stripeIdentitySession({
          status: 'verified',
          last_verification_report: {
            document: { issuing_country: 'FR', type: 'driving_license' },
          },
        }) as any
      )

      const call = boot.calls[boot.calls.length - 1]
      expect(call.sql).toContain('UPDATE')
      expect(call.sql).toContain('strav_stripe_identity_session')
      expect(call.sql).toContain('verified_at')
      expect(call.sql).toContain('canceled_at')
    })
  })

  describe('queries', () => {
    it('findByUser orders newest first', async () => {
      boot.setResult([identitySessionRow(), identitySessionRow({ id: 2 })])
      const list = await StripeIdentity.findByUser(1)
      expect(list.length).toBe(2)
      const call = boot.calls[boot.calls.length - 1]
      expect(call.sql).toContain('ORDER BY "created_at" DESC')
    })

    it('latestForUser returns null when none exist', async () => {
      boot.setResult([])
      expect(await StripeIdentity.latestForUser(1)).toBeNull()
    })

    it('latestForUser hydrates a found row', async () => {
      boot.setResult([identitySessionRow({ status: 'verified' })])
      const latest = await StripeIdentity.latestForUser(1)
      expect(latest?.status).toBe('verified')
    })

    it('findByStripeSessionId returns null when missing', async () => {
      boot.setResult([])
      expect(await StripeIdentity.findByStripeSessionId('vs_none')).toBeNull()
    })
  })

  describe('upsertFromStripe', () => {
    it('inserts when no local row exists', async () => {
      boot.setResult([]) // findByStripeSessionId → null

      await StripeIdentity.upsertFromStripe(
        1,
        stripeIdentitySession({ id: 'vs_new', status: 'processing' }) as any
      )

      const insertCall = boot.calls.find(c => c.type === 'unsafe' && c.sql.includes('INSERT'))
      expect(insertCall?.sql).toContain('strav_stripe_identity_session')
      expect(insertCall?.params[1]).toBe('vs_new')
    })

    it('routes to syncFromStripe when a local row exists', async () => {
      boot.setResult([identitySessionRow()]) // findByStripeSessionId hit

      await StripeIdentity.upsertFromStripe(
        1,
        stripeIdentitySession({ status: 'verified' }) as any
      )

      const update = boot.calls.find(c => c.sql.includes('UPDATE'))
      expect(update).toBeDefined()
    })
  })
})
