# Stripe

The stripe module (`@strav/stripe`) provides Stripe billing integration — subscriptions, one-time charges, checkout sessions, invoices, payment methods, and webhooks. Attach billing capabilities directly to your user model with the `billable()` mixin, or use the `stripe` helper object for a standalone API.

Stripe-only. Uses the official Stripe SDK under the hood.

## Installation

```bash
bun add @strav/stripe
bun strav install stripe
```

The `install` command copies files into your project:

- `config/stripe.ts` — Stripe keys, currency, webhook secret, checkout URLs.
- `database/schemas/customer.ts` — the `customer` table schema.
- `database/schemas/subscription.ts` — the `subscription` table schema.
- `database/schemas/subscription_item.ts` — the `subscription_item` table schema.
- `database/schemas/receipt.ts` — the `receipt` table schema.

All files are yours to edit. If a file already exists, the command skips it (use `--force` to overwrite).

## Setup

### 1. Register StripeManager

#### Using a service provider (recommended)

```typescript
import { StripeProvider } from '@strav/stripe'

app.use(new StripeProvider())
```

The `StripeProvider` registers `StripeManager` as a singleton. It depends on the `database` provider.

#### Manual setup

```typescript
import StripeManager from '@strav/stripe'

app.singleton(StripeManager)
app.resolve(StripeManager)
```

### 2. Configure Stripe credentials

Edit `config/stripe.ts`:

```typescript
import { env } from '@strav/kernel'

export default {
  secret: env('STRIPE_SECRET', ''),
  key: env('STRIPE_KEY', ''),
  webhookSecret: env('STRIPE_WEBHOOK_SECRET', ''),
  currency: 'usd',
  userKey: 'id',
  urls: {
    success: env('APP_URL', 'http://localhost:3000') + '/billing/success',
    cancel: env('APP_URL', 'http://localhost:3000') + '/billing/cancel',
  },
}
```

The `userKey` option controls which field on your user table is used as the foreign key in billing tables. It defaults to `'id'`, which produces a `user_id` FK column. If your user table uses a custom primary key (e.g. `uuid`), set `userKey: 'uuid'` and the FK column becomes `user_uuid`.

### 3. Run the migration

```bash
bun strav generate:migration -m "add billing tables"
bun strav migrate
```

### 4. Add environment variables

```env
STRIPE_SECRET=sk_test_...
STRIPE_KEY=pk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
```

## Billable mixin

The `billable()` mixin adds billing methods directly to your user model. This is the recommended API for most applications.

```typescript
import { BaseModel } from '@strav/database'
import { billable } from '@strav/stripe'

class User extends billable(BaseModel) {
  declare id: number
  declare email: string
}
```

Works with `compose()` for combining multiple mixins:

```typescript
import { compose } from '@strav/kernel'
import { billable } from '@strav/stripe'

class User extends compose(BaseModel, softDeletes, billable) {
  declare id: number
  declare email: string
}
```

Once applied, the user instance gains all the methods documented below.

## Customers

Every billable user is linked to a Stripe customer through the local `customer` table.

```typescript
// Get or create the Stripe customer
const customer = await user.createOrGetStripeCustomer()

// Check if the user has a Stripe customer record
await user.hasStripeId()  // true

// Get the Stripe customer ID
await user.stripeId()  // 'cus_xxx'

// Get the local customer record
const customer = await user.customer()
// customer.stripeId, customer.pmType, customer.pmLastFour, customer.trialEndsAt
```

The `createOrGetStripeCustomer()` method is idempotent — if a customer already exists, it returns the existing record. Otherwise it creates one on Stripe and stores it locally.

## Subscriptions

### Creating subscriptions

```typescript
// Simple subscription
await user.subscribe('default', 'price_xxx')

// With a trial period
await user.newSubscription('pro', 'price_xxx')
  .trialDays(14)
  .create()

// With a coupon
await user.newSubscription('pro', 'price_xxx')
  .coupon('LAUNCH20')
  .create()

// Multi-plan subscription
await user.newSubscription('enterprise', 'price_base')
  .plan('price_addon', 3)
  .create()

// Full builder API
await user.newSubscription('pro', 'price_xxx')
  .quantity(5)
  .trialDays(14)
  .coupon('LAUNCH20')
  .promotionCode('promo_abc')
  .metadata({ team: 'alpha' })
  .paymentBehavior('allow_incomplete')
  .anchorBillingCycleOn(timestamp)
  .create()
```

The `subscribe()` method is a shorthand for `newSubscription(name, price).create()`. Use `newSubscription()` when you need to configure the subscription before creating it.

### Checking subscription status

```typescript
// Is the user subscribed? (active, trialing, or on grace period)
await user.subscribed('pro')        // true
await user.subscribed()             // checks 'default'

// Is the user on a trial?
await user.onTrial('pro')           // true if trial_ends_at is in the future

// Is the subscription on a grace period? (canceled but not yet expired)
await user.onGracePeriod('pro')     // true

// Is the user subscribed to a specific price?
await user.subscribedToPrice('price_xxx')  // true

// Get subscription details
const sub = await user.subscription('pro')
sub.name            // 'pro'
sub.stripeId        // 'sub_xxx'
sub.stripeStatus    // 'active'
sub.stripePriceId   // 'price_xxx'
sub.quantity        // 1
sub.trialEndsAt     // Date | null
sub.endsAt          // Date | null

// Get all subscriptions
const subs = await user.subscriptions()
```

### Status checks on SubscriptionData

The `Subscription` class also provides pure status-check functions that operate on `SubscriptionData` objects directly:

```typescript
import Subscription from '@strav/stripe/subscription'

const sub = await user.subscription('pro')
Subscription.active(sub)        // active, trialing, or past_due
Subscription.onTrial(sub)       // trial_ends_at in the future
Subscription.onGracePeriod(sub) // ends_at in the future
Subscription.canceled(sub)      // ends_at is set
Subscription.ended(sub)         // canceled and past grace period
Subscription.pastDue(sub)       // stripe_status === 'past_due'
Subscription.recurring(sub)     // not on trial, not canceled
Subscription.valid(sub)         // active OR onTrial OR onGracePeriod
```

### Canceling subscriptions

```typescript
import Subscription from '@strav/stripe/subscription'

const sub = await user.subscription('pro')

// Cancel at period end (grace period)
await Subscription.cancel(sub)

// Cancel immediately (no grace period)
await Subscription.cancelNow(sub)
```

After canceling at period end, `onGracePeriod()` returns `true` until the current billing period expires. The user retains access during this time.

### Resuming subscriptions

Resume a subscription that was canceled but is still within its grace period:

```typescript
await Subscription.resume(sub)
```

Throws if the subscription is not on a grace period.

### Swapping plans

Switch a subscription to a different price (prorates by default):

```typescript
await Subscription.swap(sub, 'price_new')
```

### Updating quantity

```typescript
await Subscription.updateQuantity(sub, 10)
```

## One-time charges

```typescript
// Charge a payment method
const paymentIntent = await user.charge(2500, 'pm_xxx')
// amount is in the smallest currency unit (e.g. cents)

// With options
const paymentIntent = await user.charge(2500, 'pm_xxx', {
  currency: 'eur',
  description: 'Add-on purchase',
  metadata: { product: 'widget' },
})

// Refund a charge (full)
const refund = await user.refund('pi_xxx')

// Partial refund
const refund = await user.refund('pi_xxx', 1000)
```

## Payment methods

```typescript
// List all payment methods
const methods = await user.paymentMethods()

// Set a payment method as default
await user.setDefaultPaymentMethod('pm_xxx')

// Create a SetupIntent (for collecting card details without charging)
const intent = await user.createSetupIntent()
// Pass intent.client_secret to Stripe.js on the frontend
```

## Checkout sessions

Create Stripe Checkout sessions for one-time payments or subscriptions.

### Quick checkout

```typescript
// One-time payment
const session = await user.checkout([
  { price: 'price_xxx', quantity: 1 },
  { price: 'price_yyy', quantity: 2 },
])
// Redirect to session.url
```

### Checkout builder

```typescript
const session = await user.newCheckout()
  .item('price_xxx', 2)
  .item('price_yyy')
  .mode('subscription')
  .subscriptionName('pro')
  .trialDays(14)
  .successUrl('/billing/success')
  .cancelUrl('/billing/cancel')
  .allowPromotionCodes()
  .metadata({ campaign: 'launch' })
  .create()
```

The `subscriptionName()` method automatically sets `mode` to `'subscription'` and stores the name in metadata so the webhook handler can create the local record with the correct name.

### Guest checkout

For users without a Stripe customer (not logged in):

```typescript
const session = await new CheckoutBuilder()
  .item('price_xxx')
  .email('guest@example.com')
  .create()
```

When no user is passed to `.create()`, the session is created without attaching a Stripe customer. Use `.email()` to pre-fill the customer email.

## Invoices

```typescript
// List recent invoices
const invoices = await user.invoices()

// Preview the next invoice (prorations, upcoming charges)
const upcoming = await user.upcomingInvoice()
```

For direct access to invoice operations:

```typescript
import Invoice from '@strav/stripe/invoice'

const invoice = await Invoice.find('in_xxx')
const pdfUrl = await Invoice.pdfUrl('in_xxx')
const hostedUrl = await Invoice.hostedUrl('in_xxx')
await Invoice.void_('in_xxx')
```

## Billing portal

Create a Stripe Customer Portal session URL so users can manage their subscriptions, payment methods, and invoices:

```typescript
const url = await user.billingPortalUrl()
// Redirect to url

// With a custom return URL
const url = await user.billingPortalUrl('/account')
```

## Webhooks

Register a route handler to receive Stripe webhook events. The handler verifies signatures, keeps local database records in sync, and dispatches custom event handlers.

### Route setup

```typescript
import { router } from '@strav/http'
import { stripeWebhook } from '@strav/stripe/webhook'

router.post('/stripe/webhook', stripeWebhook())
```

> Note: Webhook routes should not use the `session()` or `csrf()` middleware. Stripe sends raw POST requests that won't have a session cookie or CSRF token.

### Built-in event handling

The webhook handler automatically processes these events to keep local records in sync:

| Event | Action |
|-------|--------|
| `customer.updated` | Syncs default payment method to local `customer` record |
| `customer.deleted` | Deletes local customer and all subscription records |
| `customer.subscription.created` | Creates local subscription + items (for externally created subs) |
| `customer.subscription.updated` | Syncs status, ends_at, price, quantity, trial, and items |
| `customer.subscription.deleted` | Marks local subscription as canceled |

### Custom event handlers

Register handlers for any Stripe event type:

```typescript
import { onWebhookEvent } from '@strav/stripe/webhook'

onWebhookEvent('invoice.payment_failed', async (event) => {
  const invoice = event.data.object as Stripe.Invoice
  // Send a notification to the user...
})

onWebhookEvent('checkout.session.completed', async (event) => {
  const session = event.data.object as Stripe.Checkout.Session
  // Fulfill the order...
})
```

Custom handlers run after the built-in handlers.

### Stripe CLI for local testing

Forward webhook events to your local server during development:

```bash
stripe listen --forward-to localhost:3000/stripe/webhook
```

Copy the webhook signing secret from the CLI output into your `.env`:

```env
STRIPE_WEBHOOK_SECRET=whsec_...
```

## stripe helper

The `stripe` helper provides the same functionality as the billable mixin but without requiring a model instance. Useful for standalone operations or when you don't want to use the mixin.

```typescript
import { stripe } from '@strav/stripe'

// Customer
const customer = await stripe.createOrGetCustomer(user)
const customer = await stripe.findCustomer(user)

// Subscriptions
const sub = await stripe.newSubscription('pro', 'price_xxx')
  .trialDays(14)
  .create(user)

const sub = await stripe.subscription(user, 'pro')
const isSubscribed = await stripe.subscribed(user, 'pro')

// Checkout
const session = await stripe.newCheckout()
  .item('price_xxx')
  .mode('subscription')
  .subscriptionName('pro')
  .create(user)

// Invoices & payment methods
const invoices = await stripe.invoices(user)
const upcoming = await stripe.upcomingInvoice(user)
const methods = await stripe.paymentMethods(user)
await stripe.setDefaultPaymentMethod(user, 'pm_xxx')

// Receipts
const receipts = await stripe.receipts(user)

// Direct Stripe SDK access
stripe.stripe.customers.list({ limit: 10 })
stripe.key       // publishable key for frontend
stripe.currency  // configured default currency
```

## Error handling

The module throws these error types:

- **`StripeError`** — general billing errors (extends `StravError`)
- **`CustomerNotFoundError`** — no local customer record found for a user
- **`SubscriptionNotFoundError`** — no subscription found with the given name
- **`PaymentMethodError`** — a payment method operation failed on Stripe (attach, detach, etc.)
- **`SubscriptionCreationError`** — subscription creation failed on Stripe
- **`WebhookSignatureError`** — Stripe webhook signature verification failed

```typescript
import { StripeError, PaymentMethodError, SubscriptionCreationError } from '@strav/stripe'

try {
  await user.subscribe('pro', 'price_xxx')
} catch (error) {
  if (error instanceof SubscriptionCreationError) {
    // Stripe rejected the subscription creation
  } else if (error instanceof StripeError) {
    // Other billing error
  }
}
```

## Database tables

The module uses four tables, defined by the schema stubs:

### customer

| Column | Type | Description |
|--------|------|-------------|
| `id` | `serial` | Primary key |
| `user_id` | `integer` | FK to user table |
| `stripe_id` | `varchar` | Stripe customer ID (`cus_xxx`) |
| `pm_type` | `varchar` | Default payment method type |
| `pm_last_four` | `varchar(4)` | Last 4 digits of default card |
| `trial_ends_at` | `timestamp` | Customer-level trial expiry |
| `created_at` | `timestamp` | Row creation time |
| `updated_at` | `timestamp` | Last update time |

### subscription

| Column | Type | Description |
|--------|------|-------------|
| `id` | `serial` | Primary key |
| `user_id` | `integer` | FK to user table |
| `name` | `varchar` | Subscription name (`'default'`, `'pro'`, etc.) |
| `stripe_id` | `varchar` | Stripe subscription ID (`sub_xxx`) |
| `stripe_status` | `varchar` | Stripe status (active, trialing, canceled, etc.) |
| `stripe_price_id` | `varchar` | Primary price ID |
| `quantity` | `integer` | Seat count or unit quantity |
| `trial_ends_at` | `timestamp` | Trial expiry |
| `ends_at` | `timestamp` | Set when canceled (grace period end) |
| `created_at` | `timestamp` | Row creation time |
| `updated_at` | `timestamp` | Last update time |

### subscription_item

| Column | Type | Description |
|--------|------|-------------|
| `id` | `serial` | Primary key |
| `subscription_id` | `integer` | FK to subscription table |
| `stripe_id` | `varchar` | Stripe subscription item ID (`si_xxx`) |
| `stripe_product_id` | `varchar` | Stripe product ID |
| `stripe_price_id` | `varchar` | Stripe price ID |
| `quantity` | `integer` | Item quantity |
| `created_at` | `timestamp` | Row creation time |
| `updated_at` | `timestamp` | Last update time |

### receipt

| Column | Type | Description |
|--------|------|-------------|
| `id` | `serial` | Primary key |
| `user_id` | `integer` | FK to user table |
| `stripe_id` | `varchar` | Stripe payment intent ID (`pi_xxx`) |
| `amount` | `integer` | Amount in smallest currency unit |
| `currency` | `varchar` | Currency code |
| `description` | `text` | Charge description |
| `receipt_url` | `text` | Stripe receipt URL |
| `created_at` | `timestamp` | Row creation time |

## SubscriptionData

All subscription methods return or accept a `SubscriptionData` object:

| Field | Type | Description |
|-------|------|-------------|
| `id` | `number` | Local primary key |
| `userId` | `string \| number` | Foreign key to user table |
| `name` | `string` | Subscription name |
| `stripeId` | `string` | Stripe subscription ID |
| `stripeStatus` | `string` | Stripe status |
| `stripePriceId` | `string \| null` | Primary price ID |
| `quantity` | `number \| null` | Quantity |
| `trialEndsAt` | `Date \| null` | Trial expiry |
| `endsAt` | `Date \| null` | Grace period end |
| `createdAt` | `Date` | Row creation time |
| `updatedAt` | `Date` | Last update time |

## CustomerData

| Field | Type | Description |
|-------|------|-------------|
| `id` | `number` | Local primary key |
| `userId` | `string \| number` | Foreign key to user table |
| `stripeId` | `string` | Stripe customer ID |
| `pmType` | `string \| null` | Default payment method type |
| `pmLastFour` | `string \| null` | Last 4 digits |
| `trialEndsAt` | `Date \| null` | Customer-level trial expiry |
| `createdAt` | `Date` | Row creation time |
| `updatedAt` | `Date` | Last update time |

---

# Marketplace primitives

The marketplace surface (Stripe Connect, manual-capture holds, append-only
ledger, webhook idempotency) is **opt-in** and gated by config. Existing
SaaS-style apps that don't set `stripe.connect.enabled` see no behavior
change.

Enable Connect and webhook dedup in `config/stripe.ts`:

```ts
export default {
  // …existing keys…
  connect: {
    enabled: true,
    accountType: 'express', // 'express' | 'custom' | 'standard'
    defaultCountry: 'US',
    defaultBusinessType: 'individual',
    refreshUrl: env('APP_URL') + '/billing/connect/refresh',
    returnUrl: env('APP_URL') + '/billing/connect/complete',
  },
  webhook: {
    idempotency: true, // dedup retries via strav_stripe_webhook_event
  },
}
```

Install the new schema stubs and apply the append-only triggers:

```bash
bun strav install:stubs @strav/stripe        # copies stubs/ into your app
bun strav generate:migration -m "add stripe marketplace tables"
bun strav migrate
psql $DATABASE_URL -f stubs/migrations/strav_stripe_ledger_triggers.sql
```

## Stripe Connect

Onboard a freelancer/merchant via a Stripe-hosted link:

```ts
import { stripe, StripeConnect } from '@strav/stripe'

// Create the Connect account
const acct = await StripeConnect.createAccount(freelancer, {
  email: freelancer.email,
  capabilities: { transfers: { requested: true }, card_payments: { requested: true } },
})

// Generate the onboarding URL
const link = await StripeConnect.createAccountLink(acct.stripeAccountId)
return ctx.redirect(link.url)

// Later — check status
const status = await StripeConnect.getAccountStatus(acct.stripeAccountId)
// → { chargesEnabled, payoutsEnabled, detailsSubmitted, capabilities, requirements }
```

The local mirror in `strav_stripe_connect_account` is auto-synced from
`account.updated` and `capability.updated` webhooks.

## Manual capture (authorize-only PaymentIntents)

```ts
// Authorize a hold (no capture yet)
const intent = await user.authorize(50000, paymentMethod.id, {
  description: 'Posting deposit',
})

// Later — capture all or part
await user.capture(intent.id)             // capture full amount
await user.capture(intent.id, 30000)      // partial capture

// Or release the hold
await user.cancelAuthorization(intent.id)
```

Stripe authorizations expire after roughly 7 days.

## Hold (escrow primitive)

`Hold` composes manual-capture + transfer + application fee + reversal into
a single state-machine. State transitions:

```
pending ──► authorized ──► released ──► refunded
                    │
                    ├──► refunded
                    └──► expired
```

```ts
import { Hold } from '@strav/stripe'

// Authorize a milestone hold against the client
const hold = await client.newHold(100_000, paymentMethod.id, {
  description: 'Milestone 1',
  metadata: { milestoneId: 'mst_01HXX' },
})
// hold.status === 'pending' until Stripe confirms via webhook

// On the `payment_intent.amount_capturable_updated` webhook the built-in
// handler transitions the hold to 'authorized'. After approval:
await Hold.release(hold.id, {
  destination: freelancer.stripeAccountId,
  applicationFeeAmount: 10_000, // $100 platform fee, withheld from transfer
})
// → captures the PaymentIntent, transfers (amount - fee) to the freelancer
//   account, writes 3 ledger entries (charge debit, application_fee credit,
//   transfer debit), and transitions to 'released'.

// Refund (works from 'authorized' or 'released')
await Hold.refund(hold.id)

// Cancel an authorization before capture
await Hold.cancel(hold.id)

// Inspect the append-only event trail
const events = await Hold.events(hold.id)
```

`Hold.release` runs four steps; the DB writes are transactional, but Stripe
API calls aren't part of that transaction. If the transfer fails after the
capture succeeds, the hold stays in `authorized` and the operator retries
`Hold.release()` — Stripe charges are idempotent on PaymentIntent ID, so
double-capture is impossible.

## Append-only ledger

Every charge, refund, transfer, application fee, payout and dispute writes
exactly one row to `strav_stripe_ledger`. Corrections happen via reversing
entries (new row, opposite direction) — never updates. The schema enforces
this with PostgreSQL triggers from
`stubs/migrations/strav_stripe_ledger_triggers.sql`.

```ts
import { Ledger } from '@strav/stripe'

// Read entries for a user, newest first
const recent = await Ledger.findByUser(user, { limit: 50 })

// Filter by entry type
const refunds = await Ledger.findByUser(user, { entryType: 'refund' })

// All entries for a payment intent (chronological)
const trace = await Ledger.findByIntent('pi_xxx')

// All entries for a hold (chronological)
const audit = await Ledger.findByHold(holdId)

// App-side manual entry (e.g. recording a chargeback adjustment)
await Ledger.record({
  user,
  entryType: 'adjustment',
  direction: 'debit',
  amount: 500,
  description: 'Manual fee adjustment',
})
```

`Ledger` deliberately exposes no `update` or `delete` methods; mutation is
impossible by API contract. The legacy `Receipt` static class still works
but now delegates to `Ledger` and prints a one-time deprecation warning.
Migrate with `bun strav stripe:migrate-receipts` (one-shot copy + prints
`DROP TABLE receipt;` for the operator).

## Stripe Identity (KYC)

`StripeIdentity` wraps `stripe.identity.verificationSessions.*` and keeps a
local mirror in `strav_stripe_identity_session`. Use it for any
client/freelancer KYC checkpoint — at signup, at first high-value action,
or any other risk-proportional gate.

The framework stores only the session id + status + document-country code.
Raw PII (document images, selfies) stays on Stripe's side.

```ts
import { StripeIdentity } from '@strav/stripe'

// 1) Start a session and redirect the user
const session = await client.startIdentityVerification({
  returnUrl: 'https://drafitr.com/post-job/identity/complete',
  metadata: { purpose: 'high_value_post_v1' },
})
return ctx.redirect(session.url)

// 2) Check status anytime (live read from Stripe)
const status = await StripeIdentity.getSessionStatus(session.stripeSessionId)
// → { status, documentCountry, documentType, lastErrorCode, lastErrorReason }

// 3) Convenience helpers on the billable mixin
const verified = await client.identityVerified()        // boolean — latest session is 'verified'
const latest   = await client.latestIdentityVerification()
const history  = await client.identityVerifications()

// 4) Cancel a stuck session
await StripeIdentity.cancelSession(session.stripeSessionId)
```

`type` defaults to `'document'`; pass `'id_number'` for US-SSN-style checks.
The document `allowed_types` defaults to
`['driving_license', 'passport', 'id_card']` — override via
`options.document.allowed_types`.

App code reacts to verification outcomes via the kernel `Emitter`:

```ts
import { Emitter } from '@strav/kernel'

Emitter.on('stripe:identity.verified', async ({ session }) => {
  // local strav_stripe_identity_session already updated; do app-side work
  // e.g. flip a `kyc_status` denormalization, emit your own audit event
})

Emitter.on('stripe:identity.requires_input', async ({ session }) => {
  // session.last_error?.code + .reason tell you why
})
```

| Event | Built-in action | Emitter signal |
|---|---|---|
| `identity.verification_session.created` | Upsert local row (when `metadata.strav_user_id` present) | `stripe:identity.session_created` |
| `identity.verification_session.processing` | Sync status | `stripe:identity.processing` |
| `identity.verification_session.verified` | Sync + set `verified_at` | `stripe:identity.verified` |
| `identity.verification_session.requires_input` | Sync `last_error_*` | `stripe:identity.requires_input` |
| `identity.verification_session.canceled` | Sync + set `canceled_at` | `stripe:identity.canceled` |

`StripeIdentity` is **not gated** by `connect.enabled` — Stripe Identity
is a separate product. It works out of the box once you've installed the
`strav_stripe_identity_session` schema stub.

## Webhook idempotency

Stripe retries deliveries on 5xx / timeout. Without dedup, your handlers
fire multiple times for the same event.

```ts
import { stripeWebhook } from '@strav/stripe'

router.post('/stripe/webhook', stripeWebhook({ idempotency: true }))
// Or set `stripe.webhook.idempotency = true` in config and omit the option.
```

With dedup on, each event id INSERTs (with `ON CONFLICT DO NOTHING`) into
`strav_stripe_webhook_event` after signature verification. The first
delivery wins the unique constraint and dispatches handlers; subsequent
deliveries short-circuit with `{ received: true, duplicate: true }` 200.

## Connect webhook events

When `connect.enabled` is true, `stripeWebhook()` adds built-in handling
for Connect-specific events. App code subscribes via the kernel `Emitter`:

```ts
import { Emitter } from '@strav/kernel'

Emitter.on('stripe:connect.account.updated', async ({ account }) => {
  // local strav_stripe_connect_account already synced; do app-side work
})

Emitter.on('stripe:connect.payout.paid', async ({ payout }) => {
  // notify freelancer their payout landed
})

Emitter.on('stripe:dispute.created', async ({ dispute }) => {
  // pause the disputed milestone, alert ops
})
```

| Event | Built-in action | Emitter signal |
|---|---|---|
| `account.updated` | Sync local mirror | `stripe:connect.account.updated` |
| `account.application.deauthorized` | Delete local row | `stripe:connect.account.deauthorized` |
| `capability.updated` | Refetch + sync capabilities | `stripe:connect.capability.updated` |
| `person.updated` | — | `stripe:connect.person.updated` |
| `payout.paid` | `Ledger.record('payout', 'credit', …)` | `stripe:connect.payout.paid` |
| `payout.failed` | — | `stripe:connect.payout.failed` |
| `charge.dispute.created` | — | `stripe:dispute.created` |
| `charge.dispute.funds_withdrawn` | — | `stripe:dispute.funds_withdrawn` |
| `charge.dispute.closed` | — | `stripe:dispute.closed` |
| `payment_intent.amount_capturable_updated` | `Hold.recordEvent → 'authorized'` | — |
| `payment_intent.canceled` | `Hold.recordEvent → 'expired'` | — |
| `charge.refunded` | `Ledger.record('refund', 'credit', …)` | — |

