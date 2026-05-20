import type Stripe from 'stripe'
import type { Context, Handler } from '@strav/http'
import { Emitter } from '@strav/kernel'
import StripeManager from './stripe_manager.ts'
import Customer from './customer.ts'
import Subscription from './subscription.ts'
import SubscriptionItem from './subscription_item.ts'
import StripeConnect from './connect/connect.ts'
import Hold from './hold/hold.ts'
import Ledger from './ledger/ledger.ts'
import { checkAndRecordEvent, markEventProcessed } from './webhook/idempotency.ts'
import { WebhookSignatureError } from './errors.ts'
import type { WebhookEventHandler } from './types.ts'

/** Registry of custom webhook event handlers. */
const customHandlers = new Map<string, WebhookEventHandler[]>()

/**
 * Register a custom handler for a Stripe webhook event type.
 *
 * @example
 * import { onWebhookEvent } from '@strav/stripe'
 *
 * onWebhookEvent('invoice.payment_failed', async (event) => {
 *   const invoice = event.data.object as Stripe.Invoice
 *   // Send notification to user...
 * })
 */
export function onWebhookEvent(eventType: string, handler: WebhookEventHandler): void {
  const handlers = customHandlers.get(eventType) ?? []
  handlers.push(handler)
  customHandlers.set(eventType, handlers)
}

export interface StripeWebhookOptions {
  /**
   * Deduplicate events via the `strav_stripe_webhook_event` table. When the
   * same event id arrives twice (Stripe retries, replay attacks), only the
   * first delivery dispatches handlers; subsequent deliveries return 200
   * with `{ duplicate: true }`.
   *
   * Defaults to `config.stripe.webhook.idempotency` (default false).
   * Requires the `strav_stripe_webhook_event` table.
   */
  idempotency?: boolean
}

/**
 * Create a route handler for Stripe webhooks.
 *
 * Verifies the Stripe signature, optionally deduplicates by event id,
 * dispatches built-in handlers to keep local DB in sync, then calls any
 * custom handlers registered via `onWebhookEvent()`.
 *
 * Connect-specific built-in handlers (`account.updated`, `payout.*`,
 * `charge.dispute.*`) are no-ops when `config.stripe.connect.enabled` is
 * false.
 *
 * @example
 * router.post('/stripe/webhook', stripeWebhook())
 * router.post('/stripe/webhook', stripeWebhook({ idempotency: true }))
 */
export function stripeWebhook(options: StripeWebhookOptions = {}): Handler {
  return async (ctx: Context): Promise<Response> => {
    const signature = ctx.header('stripe-signature')
    if (!signature) {
      return ctx.json({ error: 'Missing stripe-signature header' }, 400)
    }

    const rawBody = await ctx.request.text()
    const webhookSecret = StripeManager.config.webhookSecret

    let event: Stripe.Event
    try {
      event = await StripeManager.stripe.webhooks.constructEventAsync(
        rawBody,
        signature,
        webhookSecret
      )
    } catch {
      throw new WebhookSignatureError()
    }

    const idempotencyOn =
      options.idempotency ?? StripeManager.config.webhook.idempotency

    if (idempotencyOn) {
      const fresh = await checkAndRecordEvent(event.id, event.type)
      if (!fresh) {
        return ctx.json({ received: true, duplicate: true }, 200)
      }
    }

    // Dispatch built-in handlers
    await handleBuiltinEvent(event)

    // Dispatch custom handlers
    const handlers = customHandlers.get(event.type) ?? []
    for (const handler of handlers) {
      await handler(event)
    }

    if (idempotencyOn) {
      await markEventProcessed(event.id)
    }

    return ctx.json({ received: true }, 200)
  }
}

// ---------------------------------------------------------------------------
// Built-in event handling: keeps local DB in sync with Stripe
// ---------------------------------------------------------------------------

async function handleBuiltinEvent(event: Stripe.Event): Promise<void> {
  const connectEnabled = StripeManager.config.connect.enabled

  switch (event.type) {
    // ---- Customer Events ----

    case 'customer.updated': {
      const stripeCustomer = event.data.object as Stripe.Customer
      const defaultPm = stripeCustomer.invoice_settings?.default_payment_method
      if (defaultPm && typeof defaultPm !== 'string') {
        await Customer.updateDefaultPaymentMethod(stripeCustomer.id, defaultPm)
      }
      break
    }

    case 'customer.deleted': {
      const stripeCustomer = event.data.object as Stripe.Customer
      const customer = await Customer.findByStripeId(stripeCustomer.id)
      if (customer) {
        const subs = await Subscription.findByUser(customer.userId)
        for (const sub of subs) {
          await Subscription.delete(sub.id)
        }
        await Customer.deleteByStripeId(stripeCustomer.id)
      }
      break
    }

    // ---- Subscription Events ----

    case 'customer.subscription.created': {
      const stripeSub = event.data.object as Stripe.Subscription
      const customerId =
        typeof stripeSub.customer === 'string' ? stripeSub.customer : stripeSub.customer.id
      const customer = await Customer.findByStripeId(customerId)

      if (customer) {
        const existing = await Subscription.findByStripeId(stripeSub.id)
        if (!existing) {
          const name = stripeSub.metadata?.strav_name ?? 'default'
          const localSub = await Subscription.create({
            user: customer.userId,
            name,
            stripeId: stripeSub.id,
            stripeStatus: stripeSub.status,
            stripePriceId: stripeSub.items.data[0]?.price.id ?? null,
            quantity: stripeSub.items.data[0]?.quantity ?? null,
            trialEndsAt: stripeSub.trial_end ? new Date(stripeSub.trial_end * 1000) : null,
          })
          await SubscriptionItem.syncFromStripe(localSub, localSub.id)
        }
      }
      break
    }

    case 'customer.subscription.updated': {
      const stripeSub = event.data.object as Stripe.Subscription

      const endsAt = stripeSub.cancel_at
        ? new Date(stripeSub.cancel_at * 1000)
        : stripeSub.canceled_at
          ? new Date(stripeSub.current_period_end * 1000)
          : null

      await Subscription.syncStripeStatus(stripeSub.id, stripeSub.status, endsAt)

      const localSub = await Subscription.findByStripeId(stripeSub.id)
      if (localSub) {
        await SubscriptionItem.syncFromStripe(localSub, localSub.id)

        const firstItem = stripeSub.items.data[0]
        if (firstItem) {
          await StripeManager.db.sql`
            UPDATE "subscription"
            SET "stripe_price_id" = ${firstItem.price.id},
                "quantity" = ${firstItem.quantity ?? null},
                "trial_ends_at" = ${stripeSub.trial_end ? new Date(stripeSub.trial_end * 1000) : null},
                "updated_at" = NOW()
            WHERE "stripe_id" = ${stripeSub.id}
          `
        }
      }
      break
    }

    case 'customer.subscription.deleted': {
      const stripeSub = event.data.object as Stripe.Subscription
      await Subscription.syncStripeStatus(stripeSub.id, 'canceled', new Date())
      break
    }

    // ---- Connect Account Events (gated on connect.enabled) ----

    case 'account.updated': {
      if (!connectEnabled) break
      const acct = event.data.object as Stripe.Account
      await StripeConnect.syncFromStripe(acct)
      await Emitter.emit('stripe:connect.account.updated', { account: acct })
      break
    }

    case 'account.application.deauthorized': {
      if (!connectEnabled) break
      // event.data.object is a Stripe.Application, but `event.account` carries
      // the connected account id that was deauthorized.
      const accountId = (event.account as string | undefined) ?? null
      if (accountId) {
        await StripeConnect.deleteByStripeId(accountId)
      }
      await Emitter.emit('stripe:connect.account.deauthorized', { accountId })
      break
    }

    case 'capability.updated': {
      if (!connectEnabled) break
      const cap = event.data.object as Stripe.Capability
      const accountId = typeof cap.account === 'string' ? cap.account : cap.account?.id
      if (accountId) {
        const acct = await StripeManager.stripe.accounts.retrieve(accountId)
        await StripeConnect.syncFromStripe(acct)
      }
      await Emitter.emit('stripe:connect.capability.updated', { capability: cap })
      break
    }

    case 'person.updated': {
      if (!connectEnabled) break
      await Emitter.emit('stripe:connect.person.updated', { person: event.data.object })
      break
    }

    // ---- Payout Events (gated on connect.enabled) ----

    case 'payout.paid': {
      if (!connectEnabled) break
      const payout = event.data.object as Stripe.Payout
      // Payouts settle to a connected account; record on the platform side as
      // a credit ledger entry against the connect account (no local user FK
      // for platform-level payouts — write under user id 0 via metadata).
      const connectAccountId = (event.account as string) ?? null
      if (connectAccountId) {
        const localAcct = await StripeConnect.findByStripeId(connectAccountId)
        if (localAcct) {
          await Ledger.record({
            user: localAcct.userId,
            entryType: 'payout',
            direction: 'credit',
            amount: payout.amount,
            currency: payout.currency,
            connectAccountId,
            description: `Payout ${payout.id}`,
            metadata: { payoutId: payout.id, arrivalDate: payout.arrival_date },
          })
        }
      }
      await Emitter.emit('stripe:connect.payout.paid', { payout })
      break
    }

    case 'payout.failed': {
      if (!connectEnabled) break
      await Emitter.emit('stripe:connect.payout.failed', { payout: event.data.object })
      break
    }

    // ---- Dispute Events ----

    case 'charge.dispute.created': {
      const dispute = event.data.object as Stripe.Dispute
      await recordDisputeLedger(dispute)
      await Emitter.emit('stripe:dispute.created', { dispute })
      break
    }

    case 'charge.dispute.funds_withdrawn': {
      const dispute = event.data.object as Stripe.Dispute
      await recordDisputeLedger(dispute)
      await Emitter.emit('stripe:dispute.funds_withdrawn', { dispute })
      break
    }

    case 'charge.dispute.closed': {
      const dispute = event.data.object as Stripe.Dispute
      await Emitter.emit('stripe:dispute.closed', { dispute })
      break
    }

    // ---- Hold sync via PaymentIntent webhooks ----

    case 'payment_intent.amount_capturable_updated': {
      const intent = event.data.object as Stripe.PaymentIntent
      const hold = await Hold.findByPaymentIntent(intent.id)
      if (hold && hold.status === 'pending') {
        await Hold.recordEvent(hold.id, 'authorized', event.type, {
          amountCapturable: intent.amount_capturable,
        })
      }
      break
    }

    case 'payment_intent.canceled': {
      const intent = event.data.object as Stripe.PaymentIntent
      const hold = await Hold.findByPaymentIntent(intent.id)
      if (hold && (hold.status === 'pending' || hold.status === 'authorized')) {
        await Hold.recordEvent(hold.id, 'expired', event.type, {
          cancellationReason: intent.cancellation_reason,
        })
      }
      break
    }

    case 'charge.refunded': {
      const charge = event.data.object as Stripe.Charge
      const intentId = typeof charge.payment_intent === 'string' ? charge.payment_intent : null
      if (intentId) {
        const customer = await Customer.findByStripeId(
          typeof charge.customer === 'string' ? charge.customer : (charge.customer?.id ?? '')
        )
        if (customer) {
          await Ledger.record({
            user: customer.userId,
            entryType: 'refund',
            direction: 'credit',
            amount: charge.amount_refunded,
            currency: charge.currency,
            stripeIntentId: intentId,
            stripeChargeId: charge.id,
            description: `Refund on ${charge.id}`,
          })
        }
      }
      break
    }
  }
}

async function recordDisputeLedger(dispute: Stripe.Dispute): Promise<void> {
  const chargeId = typeof dispute.charge === 'string' ? dispute.charge : dispute.charge?.id
  if (!chargeId) return

  // We can't reach the local user without retrieving the charge — leave that
  // to app code via the kernel event. For audit, write a system-level entry
  // when possible. Without a user FK we skip the ledger row here; app code
  // can subscribe to `stripe:dispute.*` and write its own ledger entries
  // (e.g. `escrow_ledger`) keyed on the dispute.
  void chargeId
}
