# Stripe gateway

Adapter for [Stripe](https://stripe.com/docs/api). Use when you have a Stripe TH account (PromptPay support requires it), are outside Thailand entirely (cards-only), or want to access Stripe's broader ecosystem (Billing, Tax, etc.).

This adapter handles the basic `Gateway` operations through the unified abstraction. For Stripe-specific advanced features — Connect, Identity/KYC, Holds, Ledger — use [`@strav/stripe`](../stripe/stripe.md) directly; those concepts don't generalise to Omise.

## Auth

Bearer token with your secret key. The adapter also pins a Stripe API version so behaviour doesn't drift when Stripe ships a new release.

```typescript
import { StripeGateway, PaymentManager } from '@strav/payments'

PaymentManager.register(new StripeGateway({
  secretKey: env('STRIPE_SECRET_KEY'),         // 'sk_test_…' or 'sk_live_…'
  webhookSecret: env('STRIPE_WEBHOOK_SECRET'), // 'whsec_…' from the dashboard
  apiVersion: '2024-12-18.acacia',             // optional override
  defaultReturnUrl: 'https://app.example.com/payments/return',
}))
```

| Config | Description |
|---|---|
| `secretKey` | Required. Server-side only. |
| `webhookSecret` | Required to call `verifyWebhook`. Per-endpoint in Stripe dashboard → Webhooks. |
| `apiVersion` | Default `2024-12-18.acacia`. Pin a version; Stripe deprecates older versions on a ~2-year cycle. |
| `defaultReturnUrl` | Required for PromptPay charges — Stripe redirects the customer here after they pay (or after the QR expires). |
| `webhookToleranceSeconds` | Default 300 (5 min). How far in the past a Stripe-Signature timestamp can be. |

## PromptPay — Stripe TH only

Stripe's PromptPay support requires:

1. A Thailand-incorporated Stripe account (payouts settle to a Thai bank).
2. Currency `thb` on the PaymentIntent.
3. A `return_url` (provide via `defaultReturnUrl` config or it'll fail).

```typescript
const charge = await gateway.charge({
  amount: 89000,
  currency: 'thb',
  paymentMethodType: 'promptpay',
})

// charge.status === 'requires_action'
// charge.nextAction.imageUrl   — Stripe-hosted PNG of the QR
// charge.nextAction.payload    — raw EMV-QR data string (render natively if you want)
```

The adapter calls `POST /v1/payment_intents` with `payment_method_types=['promptpay']`, `payment_method_data[type]=promptpay`, `confirm=true`, and `return_url`. Stripe returns `next_action.promptpay_display_qr_code.{data, image_url_png, image_url_svg}`.

When the customer scans, Stripe fires `payment_intent.succeeded` → adapter surfaces `charge.succeeded`.

## Card flow

```typescript
// 1. Customer
const customer = await gateway.createCustomer({ email, name })

// 2. Attach a PaymentMethod — typically tokenised on the client with Stripe.js
const method = await gateway.attachPaymentMethod(customer.id, 'pm_xxx')
// Also sets invoice_settings.default_payment_method so Subscriptions work
// without an extra call.

// 3. Off-session charge
const charge = await gateway.charge({
  amount: 39000,
  currency: 'thb',
  customerId: customer.id,
  paymentMethodType: 'card',
  idempotencyKey: `inv-${invoiceId}`,
})
```

For one-shot charges without a saved customer, pass `paymentMethodId` (a fresh `pm_…`) instead of `customerId`.

## Subscriptions (card)

Pass a Stripe `price_…` ID as `planId`:

```typescript
const sub = await gateway.createSubscription({
  customerId: customer.id,
  planId: 'price_xxx',          // Stripe price id from dashboard or programmatic
  trialDays: 14,
})

// Cancel at end of the current period (typical user flow)
await gateway.cancelSubscription(sub.id, { atPeriodEnd: true })

// Cancel immediately
await gateway.cancelSubscription(sub.id)
```

The adapter sets `cancel_at_period_end=true` for the "atPeriodEnd" path and falls back to `DELETE /v1/subscriptions/{id}` for the immediate path.

## Webhook verification

Stripe delivers `Stripe-Signature: t=<unix_ts>,v1=<hex_hmac>`. The adapter recomputes HMAC-SHA256 over `<timestamp>.<body>` with your webhook secret and rejects:

- Missing or malformed header
- Mismatched signature (constant-time comparison)
- Timestamps outside `webhookToleranceSeconds` (replay protection)

```typescript
router.post('/webhooks/stripe', async ctx => {
  const body = Buffer.from(await ctx.request.arrayBuffer())
  const headers = Object.fromEntries(ctx.request.headers.entries())

  let event
  try {
    event = PaymentManager.gateway('stripe').verifyWebhook(headers, body)
  } catch (err) {
    return ctx.text('invalid signature', 400)
  }
  // event.type is the canonical name; event.raw is the full Stripe event
})
```

| Stripe `type` | Canonical `event.type` |
|---|---|
| `payment_intent.succeeded` | `charge.succeeded` |
| `payment_intent.payment_failed` | `charge.failed` |
| `payment_intent.processing` | `charge.pending` |
| `payment_intent.requires_action` | `charge.requires_action` |
| `customer.subscription.created` | `subscription.created` |
| `customer.subscription.deleted` | `subscription.canceled` |
| `invoice.paid` | `subscription.renewed` |
| `invoice.payment_failed` | `subscription.payment_failed` |

Anything not in this set comes through with `type: 'unknown'`. Stripe ships many event types — most aren't relevant to billing flow, so peek at `event.raw.type` for the rare cases.

## Gotchas

- **PromptPay = TH account.** Cross-border Stripe accounts can't accept PromptPay. The API simply errors. If you're stuck on a non-TH Stripe account, use the Omise adapter instead.
- **Return URL is mandatory for PromptPay.** Stripe redirects the customer there after the action (success or expiry). Set `defaultReturnUrl` in config; otherwise the PaymentIntent creation will fail.
- **API version pinning matters.** A newer Stripe-Version subtly changes response shapes (some fields move from snake_case to camelCase, some are removed). Pin a version and bump deliberately with a test pass.
- **Idempotency keys.** Stripe honours `Idempotency-Key` for any POST. The adapter forwards `input.idempotencyKey` — supply it on every charge from your durable workflow step id.
- **`amount` is integer minor units.** 100 THB = 10000, $1.00 = 100. Stripe rejects decimals.
- **Subscriptions and PromptPay don't mix.** If you want PromptPay subscriptions, drive them from your app's scheduler (see [Recurring PromptPay](./payments.md#recurring-promptpay)) — Stripe Subscriptions assume off-session-capable methods (cards, SEPA Direct Debit).
- **Webhook signing secret is per-endpoint.** Each webhook endpoint in the Stripe dashboard has its own `whsec_…`. If you have multiple endpoints (test + live, or per-environment), configure them separately.
- **Test mode.** Use `sk_test_…` keys; mock cards like `4242 4242 4242 4242`, expiry any future date. PromptPay test mode shows a placeholder QR that resolves automatically.
