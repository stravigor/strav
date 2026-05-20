import { describe, it, expect, beforeEach, afterEach } from 'bun:test'
import { Emitter } from '@strav/kernel'
import { stripeWebhook } from '../src/webhook.ts'
import { bootStripe, stripeIdentitySession } from './helpers.ts'

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

describe('webhook — identity.verification_session.*', () => {
  let boot: ReturnType<typeof bootStripe>

  beforeEach(() => {
    boot = bootStripe()
    Emitter.off()
  })

  afterEach(() => {
    Emitter.off()
  })

  it('created — upserts local row from metadata.strav_user_id + emits', async () => {
    boot.stripe.onCall('webhooks.constructEventAsync', {
      id: 'evt_c',
      type: 'identity.verification_session.created',
      data: { object: stripeIdentitySession({ status: 'requires_input' }) },
    })
    boot.setResult([]) // findByStripeSessionId → null → INSERT path

    const emitted: any[] = []
    Emitter.on('stripe:identity.session_created', async p => emitted.push(p))

    await stripeWebhook()(mockCtx('{}', 'sig'))

    const insert = boot.calls.find(
      c => c.type === 'unsafe' && c.sql.includes('INSERT INTO "strav_stripe_identity_session"')
    )
    expect(insert).toBeDefined()
    expect(insert?.params[1]).toBe('vs_test123')
    expect(emitted.length).toBe(1)
  })

  it('processing — syncs status and emits', async () => {
    boot.stripe.onCall('webhooks.constructEventAsync', {
      id: 'evt_p',
      type: 'identity.verification_session.processing',
      data: { object: stripeIdentitySession({ status: 'processing' }) },
    })
    boot.setResult([])

    const emitted: any[] = []
    Emitter.on('stripe:identity.processing', async p => emitted.push(p))

    await stripeWebhook()(mockCtx('{}', 'sig'))

    const update = boot.calls.find(
      c => c.sql.includes('UPDATE') && c.sql.includes('strav_stripe_identity_session')
    )
    expect(update).toBeDefined()
    expect(emitted.length).toBe(1)
  })

  it('verified — syncs verified_at via COALESCE + emits with session', async () => {
    boot.stripe.onCall('webhooks.constructEventAsync', {
      id: 'evt_v',
      type: 'identity.verification_session.verified',
      data: {
        object: stripeIdentitySession({
          status: 'verified',
          last_verification_report: { document: { issuing_country: 'US', type: 'passport' } },
        }),
      },
    })
    boot.setResult([])

    const emitted: any[] = []
    Emitter.on('stripe:identity.verified', async p => emitted.push(p))

    await stripeWebhook()(mockCtx('{}', 'sig'))

    const update = boot.calls.find(
      c => c.sql.includes('UPDATE') && c.sql.includes('strav_stripe_identity_session')
    )
    expect(update?.sql).toContain('verified_at')
    expect(emitted[0].session.status).toBe('verified')
  })

  it('requires_input — syncs last_error + emits', async () => {
    boot.stripe.onCall('webhooks.constructEventAsync', {
      id: 'evt_r',
      type: 'identity.verification_session.requires_input',
      data: {
        object: stripeIdentitySession({
          status: 'requires_input',
          last_error: { code: 'consent_declined', reason: 'User declined consent' },
        }),
      },
    })
    boot.setResult([])

    const emitted: any[] = []
    Emitter.on('stripe:identity.requires_input', async p => emitted.push(p))

    await stripeWebhook()(mockCtx('{}', 'sig'))

    expect(emitted[0].session.last_error.code).toBe('consent_declined')
  })

  it('canceled — syncs canceled_at + emits', async () => {
    boot.stripe.onCall('webhooks.constructEventAsync', {
      id: 'evt_x',
      type: 'identity.verification_session.canceled',
      data: { object: stripeIdentitySession({ status: 'canceled' }) },
    })
    boot.setResult([])

    const emitted: any[] = []
    Emitter.on('stripe:identity.canceled', async p => emitted.push(p))

    await stripeWebhook()(mockCtx('{}', 'sig'))

    const update = boot.calls.find(
      c => c.sql.includes('UPDATE') && c.sql.includes('strav_stripe_identity_session')
    )
    expect(update?.sql).toContain('canceled_at')
    expect(emitted.length).toBe(1)
  })

  it('created — skips upsert when metadata.strav_user_id is missing (still emits)', async () => {
    boot.stripe.onCall('webhooks.constructEventAsync', {
      id: 'evt_c2',
      type: 'identity.verification_session.created',
      data: {
        object: stripeIdentitySession({ metadata: {} }),
      },
    })
    boot.setResult([])

    const emitted: any[] = []
    Emitter.on('stripe:identity.session_created', async p => emitted.push(p))

    await stripeWebhook()(mockCtx('{}', 'sig'))

    const insert = boot.calls.find(
      c => c.type === 'unsafe' && c.sql.includes('INSERT INTO "strav_stripe_identity_session"')
    )
    expect(insert).toBeUndefined()
    expect(emitted.length).toBe(1) // event still fires for app-side handlers
  })
})
