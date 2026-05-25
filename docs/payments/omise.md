# Omise gateway

Adapter for [Omise (Opn Payments)](https://docs.opn.ooo/). The default choice when shipping in Thailand without a Thai legal entity — Opn accepts non-TH merchant accounts via their cross-border setup and supports PromptPay, cards, TrueMoney, and bank transfers.

## Auth

HTTP Basic with your secret key as the username and an empty password — Omise's documented scheme. The adapter handles the Base64 encoding for you.

```typescript
import { OmiseGateway, PaymentManager } from '@strav/payments'

PaymentManager.register(new OmiseGateway({
  secretKey: env('OMISE_SECRET_KEY'),         // 'skey_test_…' or 'skey_…'
  webhookSecret: env('OMISE_WEBHOOK_SECRET'), // set in Opn dashboard under Webhooks
}))
```

| Config | Description |
|---|---|
| `secretKey` | Required. Server-side only. Issued in the Opn Payments dashboard. |
| `webhookSecret` | Required to call `verifyWebhook`. Configure in dashboard → Webhooks → Sign requests. |
| `baseUrl` | Override API host. Default `https://api.omise.co`. |

## Card flow

```typescript
// 1. Create a customer
const customer = await gateway.createCustomer({ email, name })

// 2. Attach a card (token from the client SDK — never raw card details on your server)
await gateway.attachPaymentMethod(customer.id, tokenId)

// 3. Charge off-session
const charge = await gateway.charge({
  amount: 39000,                  // 390.00 THB in satang
  currency: 'thb',
  customerId: customer.id,
  paymentMethodType: 'card',
  idempotencyKey: `inv-${invoiceId}`,
})
// charge.status === 'succeeded' on capture, 'failed' on decline
```

The adapter sets the attached card as the customer's `default_card`, so subsequent off-session charges and subscriptions pick it up automatically.

## PromptPay flow

```typescript
const charge = await gateway.charge({
  amount: 89000,
  currency: 'thb',
  paymentMethodType: 'promptpay',
})

// charge.status === 'requires_action'
// charge.nextAction.imageUrl === '<Opn-hosted PNG URL>'
```

Under the hood the adapter:

1. `POST /sources` with `type=promptpay`, `amount`, `currency=thb` → Opn returns a source with `scannable_code.image.download_uri`.
2. `POST /charges` with that source id → Opn creates a pending charge.
3. Adapter merges the QR URL onto `charge.nextAction.imageUrl`.

When the customer scans and pays, Opn fires the `charge.complete` webhook → adapter surfaces it as `charge.succeeded`.

## Subscriptions (card)

Omise's `/schedules` endpoint backs card recurring. Unlike Stripe there's no server-side "plan" concept — your app owns the plan catalog, and the adapter encodes the schedule shape into the `planId` string:

```
<period>:<amountSatang>:<currency>
```

Valid periods: `daily`, `weekly`, `monthly`.

```typescript
const sub = await gateway.createSubscription({
  customerId: 'cust_xxx',
  planId: 'monthly:89000:thb',
})
// sub.id is the Omise schedule id 'schd_xxx'
// sub.status === 'active' when status='running'
```

`cancelSubscription(id, { atPeriodEnd: true })` is a soft no-op (Omise schedules don't support "cancel at period end" — they run until `end_date` or until destroyed). Pass `atPeriodEnd: false` (or omit) to delete the schedule immediately.

## Webhook verification

Opn delivers `X-Opn-Signature: sha256=<hex>` (newer) or `X-Omise-Signature` (older) over HMAC-SHA256 of the raw body. The adapter accepts both header names.

```typescript
router.post('/webhooks/omise', async ctx => {
  const body = Buffer.from(await ctx.request.arrayBuffer())
  const headers = Object.fromEntries(ctx.request.headers.entries())

  const event = PaymentManager.gateway('omise').verifyWebhook(headers, body)
  // event.type is the canonical name; event.raw is Opn's original payload
})
```

| Opn `key` | Canonical `event.type` |
|---|---|
| `charge.create` | `charge.pending` |
| `charge.complete` | `charge.succeeded` |
| `charge.failed` | `charge.failed` |
| `charge.expired` | `charge.failed` |
| `schedule.create` | `subscription.created` |
| `schedule.destroy`, `schedule.expiring` | `subscription.canceled` |
| `schedule_occurrence.complete` | `subscription.renewed` |
| `schedule_occurrence.failed` | `subscription.payment_failed` |

Anything else (refunds, disputes, transfer events) comes through with `type: 'unknown'` and the raw payload — handle it directly off `event.raw.key`.

## Gotchas

- **Cross-border accounts settle in your home currency.** Opn converts THB to whatever your bank account holds, with a small FX margin. Margin and timing depend on your account tier — check with Opn before you scale.
- **PromptPay sources are short-lived.** The QR has a few-minute window before it expires. If the customer is slow, create a fresh charge — don't cache QR images.
- **Webhook secret has two names in dashboards.** "Webhook secret" / "Signing secret" — they're the same value, distinct from your secret key.
- **No `cancel_at_period_end` semantic.** If you want "cancel at the end of the cycle", track the intent in your DB and let the schedule run to its `end_date`; or set the schedule's `end_date` to the current cycle's end.
- **Idempotency key support.** Omise honours `Idempotency-Key` for `POST /charges` — pass `idempotencyKey` on every charge call (the durable workflow step id is a good default).
- **Test mode.** Use `skey_test_…` keys against `https://api.omise.co` (no separate test host). Toggle live/test via the dashboard. Test cards: `4242 4242 4242 4242`, any future expiry.
