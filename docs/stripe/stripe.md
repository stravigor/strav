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
