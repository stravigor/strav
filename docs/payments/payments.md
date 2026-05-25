# Payments

Gateway-agnostic payment abstraction — **Omise (Opn Payments)** and **Stripe** behind one `Gateway` interface. Supports card charges, card-based subscriptions, and PromptPay QR with a built-in helper to deliver the QR via LINE.

Use `@strav/payments` when you want your billing code to remain portable across gateways — switch between Omise and Stripe (or add a new provider) without touching the call sites.

For Stripe-specific advanced features (Connect, Identity/KYC, Holds, Ledger), keep using [`@strav/stripe`](../stripe/stripe.md) — those concepts don't generalise across gateways and stay native. This package supersedes only the basic subscription/checkout flow.

## Gateway picker

| Constraint | Pick | Why |
|---|---|---|
| You're shipping in Thailand without a Thai legal entity | **Omise** | Opn Payments accepts non-TH merchant accounts via their cross-border setup. Supports PromptPay, cards, TrueMoney. |
| You have a Stripe TH account | Stripe | Stripe Thailand supports PromptPay end-to-end. Get all the Stripe ecosystem (Billing, Invoices, Tax). |
| Outside Thailand, international cards only | Stripe | Best DX, broadest country coverage. |
| Want both | Register both | Default to one, dispatch to the other per-call via `PaymentManager.gateway('stripe')`. |

PromptPay specifically is a single-use bank-redirect method on **both** gateways — you can't save it for off-session card-style recurring. Both adapters surface the same `requires_action` charge shape with the QR URL in `nextAction.imageUrl`. Subscription cycles for PromptPay are app-driven: schedule a fresh `charge()` per cycle and deliver each new QR via LINE.

## Quick start

```typescript
import { PaymentManager, OmiseGateway } from '@strav/payments'
import { sendPromptPayQrViaLine } from '@strav/payments/line'

// Wiring (typically in your app's bootstrap)
PaymentManager.register(new OmiseGateway({
  secretKey: env('OMISE_SECRET_KEY'),
  webhookSecret: env('OMISE_WEBHOOK_SECRET'),
}))

// Charge — PromptPay returns a requires_action charge with the QR URL
const charge = await PaymentManager.gateway().charge({
  amount: 89000,                  // 890.00 THB in satang
  currency: 'thb',
  paymentMethodType: 'promptpay',
})

// Push the QR to the SME owner's LINE OA
if (charge.status === 'requires_action') {
  await sendPromptPayQrViaLine(charge, {
    to: ownerLineUserId,
    channelAccessToken: tenantOaToken,
    subtitle: 'Acme — Hotel tier — May 2026',
    amountDisplay: '฿890.00',
  })
}
```

## Install

```bash
bun add @strav/payments
```

Peer dependencies: `@strav/kernel`, `@strav/line`.

## Setup

### Service provider

```typescript
import { PaymentProvider } from '@strav/payments'

app.use(new PaymentProvider())
```

`PaymentProvider` registers `PaymentManager` as a singleton. It does **not** auto-register any concrete gateways — apps register the ones they need with their own configuration:

```typescript
import { OmiseGateway, StripeGateway, PaymentManager } from '@strav/payments'

PaymentManager.register(new OmiseGateway({
  secretKey: env('OMISE_SECRET_KEY'),
  webhookSecret: env('OMISE_WEBHOOK_SECRET'),
}))

// Optional second gateway, e.g. for international card customers
PaymentManager.register(new StripeGateway({
  secretKey: env('STRIPE_SECRET_KEY'),
  webhookSecret: env('STRIPE_WEBHOOK_SECRET'),
  defaultReturnUrl: 'https://app.example.com/payments/return',
}))
```

The first gateway registered becomes the default. Override via `config.payments.default = 'stripe'` or call `PaymentManager.setDefault('stripe')` at runtime.

## Core concepts

### `Gateway` — the adapter contract

```typescript
interface Gateway {
  readonly name: string
  createCustomer(input): Promise<GatewayCustomer>
  attachPaymentMethod(customerId, paymentMethodId): Promise<SavedPaymentMethod>
  charge(input): Promise<Charge>
  createSubscription(input): Promise<Subscription>
  cancelSubscription(id, { atPeriodEnd? }): Promise<Subscription>
  verifyWebhook(headers, rawBody): WebhookEvent
}
```

Built-ins: `OmiseGateway`, `StripeGateway`. Apps can register custom gateways under any string name (TrueMoney, 2C2P, dummy fakes for testing).

### Amounts

Everything is in **minor units** (integers). For THB, 99.00 baht = 9900 satang. For USD, $5.00 = 500 cents. Mirrors what both gateways expect on the wire and avoids floating-point bugs.

### `Charge` — the unified result shape

```typescript
interface Charge {
  id: string
  amount: MinorAmount
  currency: CurrencyCode
  status: 'succeeded' | 'pending' | 'requires_action' | 'failed'
  nextAction?: { type: 'promptpay_display_qr', imageUrl?, payload?, expiresAt? }
  customerId?: string
  raw: unknown
}
```

For cards, `status` is `succeeded` or `failed` immediately. For PromptPay, `status` is `requires_action` with `nextAction.imageUrl` carrying the hosted QR PNG — listen for the webhook event `charge.succeeded` to confirm settlement.

### Webhook events — canonical

`verifyWebhook(headers, rawBody)` normalises every supported provider event into one shape:

```typescript
type CanonicalEventType =
  | 'charge.succeeded' | 'charge.pending' | 'charge.failed' | 'charge.requires_action'
  | 'subscription.created' | 'subscription.renewed' | 'subscription.canceled' | 'subscription.payment_failed'
  | 'unknown'
```

Branch on `event.type`; the original gateway payload is in `event.raw` for the rare case you need provider-specific fields.

| Canonical | Omise | Stripe |
|---|---|---|
| `charge.succeeded` | `charge.complete` | `payment_intent.succeeded` |
| `charge.failed` | `charge.failed`, `charge.expired` | `payment_intent.payment_failed` |
| `charge.pending` | `charge.create` | `payment_intent.processing` |
| `charge.requires_action` | — | `payment_intent.requires_action` |
| `subscription.created` | `schedule.create` | `customer.subscription.created` |
| `subscription.renewed` | `schedule_occurrence.complete` | `invoice.paid` |
| `subscription.canceled` | `schedule.destroy`, `schedule.expiring` | `customer.subscription.deleted` |
| `subscription.payment_failed` | `schedule_occurrence.failed` | `invoice.payment_failed` |

## Charging

### Card — off-session (saved customer)

```typescript
const customer = await PaymentManager.gateway().createCustomer({
  email: 'somchai@example.com',
  name: 'Somchai',
})
// On the client side, tokenise a card with the gateway's JS SDK and POST
// the token to your server. Then attach:
const method = await PaymentManager.gateway().attachPaymentMethod(customer.id, tokenId)

// Later, charge off-session
const charge = await PaymentManager.gateway().charge({
  amount: 39000,
  currency: 'thb',
  customerId: customer.id,
  paymentMethodType: 'card',
  idempotencyKey: `invoice-${invoiceId}`,
})
```

### Card — one-shot (no saved customer)

```typescript
const charge = await PaymentManager.gateway().charge({
  amount: 39000,
  currency: 'thb',
  paymentMethodId: tokenId,       // gateway-native token (pm_… / tokn_…)
  paymentMethodType: 'card',
})
```

### PromptPay

```typescript
const charge = await PaymentManager.gateway().charge({
  amount: 89000,
  currency: 'thb',
  paymentMethodType: 'promptpay',
})

if (charge.status === 'requires_action' && charge.nextAction?.imageUrl) {
  // Send the QR to the customer however you like — LINE is built in:
  await sendPromptPayQrViaLine(charge, {
    to: customerLineUserId,
    channelAccessToken: tenantOaToken,
  })
  // Or render the image inline in a web view, email, etc.
}

// Wait for webhook charge.succeeded for settlement.
```

## Subscriptions

Both gateways support **card-based recurring** out of the box. PromptPay-style recurring is app-driven — see [Recurring PromptPay](#recurring-promptpay) below.

```typescript
const sub = await PaymentManager.gateway().createSubscription({
  customerId: customer.id,
  planId: 'price_xxx',           // Stripe price id, or Omise's encoded 'monthly:89000:thb'
  trialDays: 14,
})

// Cancel at the end of the current billing period (typical user-facing flow)
await PaymentManager.gateway().cancelSubscription(sub.id, { atPeriodEnd: true })

// Or cancel immediately
await PaymentManager.gateway().cancelSubscription(sub.id)
```

### planId conventions per gateway

- **Stripe**: pass a `price_xxx` ID from the Stripe dashboard.
- **Omise**: pass an encoded string `<period>:<amountSatang>:<currency>` (e.g. `monthly:89000:thb`, `weekly:25000:thb`). Omise has no server-side "price" concept; the app owns the plan catalog and encodes it into the planId.

### Recurring PromptPay

PromptPay can't be saved off-session, so renewal is app-driven:

1. **Set up a scheduled job** (use `@strav/queue`'s Scheduler) that fires per tenant on the cycle anniversary.
2. **In the job**, call `gateway.charge({ paymentMethodType: 'promptpay', amount, currency: 'thb' })`.
3. **Deliver the QR** via LINE: `sendPromptPayQrViaLine(charge, { to, channelAccessToken })`.
4. **On webhook `charge.succeeded`**, mark the cycle paid in your DB.
5. **On webhook `charge.failed`** (or after a timeout if no event fires), reschedule a retry or downgrade to a free tier.

The natural orchestration: one `@strav/durable` workflow per renewal cycle, with retries baked in. The LINE bot itself becomes the payment surface — much better UX than emailing invoices to SME owners.

## Webhooks

Verify in your HTTP handler. The HTTP layer **must** surface the raw bytes — re-stringified JSON breaks HMAC.

```typescript
import { Router } from '@strav/http'
import { PaymentManager } from '@strav/payments'

router.post('/webhooks/omise', async ctx => {
  const body = Buffer.from(await ctx.request.arrayBuffer())
  const headers = Object.fromEntries(ctx.request.headers.entries())

  let event
  try {
    event = PaymentManager.gateway('omise').verifyWebhook(headers, body)
  } catch (err) {
    return ctx.text('invalid signature', 400)
  }

  switch (event.type) {
    case 'charge.succeeded':
      await markChargePaid(event.resource as Charge)
      break
    case 'subscription.renewed':
      await advanceSubscriptionPeriod(event.resource as Subscription)
      break
    case 'subscription.payment_failed':
      await notifyDunning(event.resource as Subscription)
      break
    case 'unknown':
      // Provider event we don't normalise — peek at event.raw if needed.
      break
  }

  return ctx.text('OK')
})
```

Stripe webhooks additionally enforce a 5-minute timestamp tolerance (defeats replay) — override via `StripeGatewayConfig.webhookToleranceSeconds`.

## PromptPay-via-LINE helper

Re-exported from `@strav/payments/line`. Two ways to use it:

### `promptPayFlex(charge, options)` — builder

Returns a `FlexMessage` you can send via your own `LineClient`, or include in a multi-message reply.

```typescript
import { promptPayFlex } from '@strav/payments'
import { LineManager } from '@strav/line'

const message = promptPayFlex(charge, {
  title: 'สแกนเพื่อชำระเงิน',
  subtitle: 'Acme — Hotel — May 2026',
  amountDisplay: '฿890.00',
  instructionsUrl: 'https://help.example.com/promptpay',
})

await LineManager.client.push(ownerUserId, message)
```

### `sendPromptPayQrViaLine(charge, options)` — convenience

Builds the Flex and pushes it in one call. Convenient for the multi-tenant case where each tenant has their own LINE OA and you don't want to construct a `LineClient` ahead of time.

```typescript
await sendPromptPayQrViaLine(charge, {
  to: ownerUserId,
  channelAccessToken: tenantOaToken,
  amountDisplay: '฿890.00',
})

// Or pass a pre-built client (for testing, custom retry, etc.)
await sendPromptPayQrViaLine(charge, { to: ownerUserId, client: myLineClient })
```

The Flex layout is intentionally minimal: title → subtitle → QR image → amount → optional "view instructions" footer. Customise via `promptPayFlex` directly and build your own bubble around it if you want richer copy.

## Errors

| Class | When |
|---|---|
| `PaymentError` | Gateway API returned non-2xx, or input validation failed inside an adapter. Carries `.gateway`, `.status?`, `.code?`, `.raw?`. |
| `WebhookVerificationError` | Signature missing, malformed, mismatched, or timestamp out of tolerance. Always return 400 to the gateway so they retry. |
| `GatewayNotRegisteredError` | `PaymentManager.gateway(name)` for an unregistered name. Wire up `PaymentManager.register(...)` at boot. |

Catch shape inside a renewal job:

```typescript
try {
  const charge = await PaymentManager.gateway().charge({ ... })
} catch (err) {
  if (err instanceof PaymentError && err.code === 'invalid_card') {
    await notifyCardDeclined(tenantId)
    return
  }
  throw err   // unexpected — let the queue retry
}
```

## Per-gateway notes

- [Omise (Opn Payments)](./omise.md) — PromptPay-first, Thai SMEs without a TH entity, schedule API quirks
- [Stripe](./stripe.md) — TH account requirement for PromptPay, PaymentIntents, Subscriptions

## Testing

`PaymentManager.reset()` clears all registered gateways and the default — pair with `PaymentManager.register(new FakeGateway('omise'))` in `beforeEach`:

```typescript
import PaymentManager from '@strav/payments'
import type { Gateway } from '@strav/payments'

class FakeOmise implements Gateway {
  readonly name = 'omise'
  charges: unknown[] = []
  // ... implement minimal subset for the test
}

beforeEach(() => {
  PaymentManager.reset()
  PaymentManager.register(new FakeOmise())
})
```

The adapter tests mock `globalThis.fetch` and assert against the request body shape. See `packages/payments/tests/_fetch_mock.ts` for the helper and `packages/payments/tests/omise_gateway.test.ts` for usage.

## Security

- **Webhook secrets are mandatory.** Both gateways reject inbound webhooks at the signature-verification stage when the secret is missing. There is no "skip" mode in production code.
- **Constant-time comparisons.** All HMAC checks use `node:crypto`'s `timingSafeEqual` — same scheme as `@strav/signal`'s webhook subscriber system.
- **Raw body required.** HMAC is computed over the bytes the gateway delivered; the HTTP layer must surface them unparsed. Re-stringifying JSON breaks verification.
- **No PII in error logs.** `PaymentError.raw` carries the gateway's error envelope (status, code, message) — typically does NOT include card numbers or tokens, which never leave the gateway. Still: redact `raw` from any log sink that goes to a third party.
- **Idempotency.** Both gateways respect `Idempotency-Key` headers — surface `idempotencyKey` from your durable workflow's step ID so retries don't double-charge.
