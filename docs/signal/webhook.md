# Webhook (outbound subscribers)

Customer-registered webhook endpoints with HMAC-signed delivery, exponential-backoff retry, dead-letter queue, and replay. Distinct from the per-recipient [notification webhook channel](./notification.md#webhook) — this module models *event subscribers* (think Stripe webhooks): customers register their own URLs to receive events, the framework guarantees delivery.

## Quick start

```typescript
import { webhook } from '@strav/signal'

// Customer registers an endpoint (typically from a settings UI)
const endpoint = await webhook.endpoints.create({
  url: 'https://customer.example/hooks/leads',
  secret: 'wh_secret_xyz',          // shared with the customer; used as HMAC key
  events: ['lead.created', 'lead.updated'],
})

// App fires an event — fans out to every endpoint subscribed to it
await webhook.dispatch('lead.created', { id: leadId, email, score })

// Replay a dead-lettered delivery once the receiver is fixed
await webhook.replay(deliveryId)
```

## Setup

### Using a service provider (recommended)

```typescript
import { WebhookProvider } from '@strav/signal'

app.use(new WebhookProvider())
```

Depends on `config`, `database`, and `queue`. By default it auto-creates the `_strav_webhook_endpoints` and `_strav_webhook_deliveries` tables and registers the queue handler that processes delivery jobs.

| Option | Default | Description |
|---|---|---|
| `ensureTables` | `true` | Auto-create the webhook tables. |
| `registerQueueHandler` | `true` | Register the `strav:webhook-deliver` queue handler. |

### Manual setup

```typescript
import { WebhookManager, webhook } from '@strav/signal'

app.singleton(WebhookManager)
app.resolve(WebhookManager)
await WebhookManager.ensureTables()
webhook.registerQueueHandler()
```

Configure `config/webhook.ts`:

```typescript
export default {
  driver: 'database',           // 'database' | 'memory'
  maxAttempts: 8,
  baseDelayMs: 30_000,          // first retry after 30 s
  factor: 2,                    // exponential
  ceilingMs: 12 * 60 * 60_000,  // cap any retry at 12 h
  jitter: 0.2,                  // ±20%
  responseBodyLimit: 65_536,    // truncate stored response bodies
  fetchTimeoutMs: 15_000,
}
```

## Endpoint management

```typescript
const endpoints = await webhook.endpoints.list()
const ep = await webhook.endpoints.get(id)
await webhook.endpoints.update(id, { active: false })
await webhook.endpoints.delete(id)
```

`events: ['*']` subscribes the endpoint to every event. Otherwise, only events whose name appears verbatim in `events` are dispatched to the endpoint.

## Dispatch

```typescript
const result = await webhook.dispatch('lead.created', payload)
// result.deliveries: WebhookDelivery[] (one per matching endpoint)

// Skip the queue, deliver synchronously (useful in tests)
await webhook.dispatch('lead.created', payload, { immediate: true })

// Force-target a specific endpoint id
await webhook.dispatch('lead.created', payload, { endpointId })
```

Each match creates a `WebhookDelivery` row in `'pending'` status and pushes a `strav:webhook-deliver` job onto the queue. The job worker calls `WebhookManager.deliverNow(deliveryId)`, which:

1. signs the request and POSTs the JSON body,
2. stores the response status / body (truncated to `responseBodyLimit`),
3. on 2xx → status `'delivered'`,
4. on 4xx/5xx/network error → schedules a retry with `nextDelayMs(attempts)` via `Queue.push(..., { delay })`,
5. after `maxAttempts` failures → status `'dead'`. Operator calls `webhook.replay(deliveryId)` to re-queue.

## Signature scheme

Each delivery sends:

```
POST /your/endpoint
Content-Type: application/json
User-Agent: strav-webhooks/1
X-Strav-Delivery: <delivery_id>
X-Strav-Event: lead.created
X-Strav-Timestamp: 1714600000
X-Strav-Signature: sha256=<hex(HMAC-SHA256(secret, timestamp + "." + body))>
```

### Subscribers verify by recomputing

```typescript
import { verifySignature } from '@strav/signal'

const body = await request.text()             // RAW body — not re-stringified
const ok = verifySignature({
  secret: process.env.WEBHOOK_SECRET!,
  body,
  timestamp: request.headers.get('X-Strav-Timestamp')!,
  signature: request.headers.get('X-Strav-Signature')!,
})
if (!ok) return new Response('forbidden', { status: 403 })
```

The verifier is constant-time, tolerates the `sha256=` prefix being stripped, and rejects timestamps older than `maxAgeSeconds` (default **60 seconds** — narrowly bounded against replay; adjust upward only if you have receivers behind a slow proxy or wide clock skew).

## Retry policy

```
delay(attempt) = min(baseDelayMs * factor ^ (attempt - 1), ceilingMs) * (1 ± jitter)
```

With defaults the backoff goes 30 s, 1 m, 2 m, 4 m, 8 m, 16 m, 32 m, 1 h 4 m → DLQ at 8 attempts. Jitter is symmetric: ±20% by default.

A failed delivery row stays in `'pending'` status with `next_retry_at` populated until either it's picked up by the worker or `replay()` is called manually.

## Querying deliveries

```typescript
const failed = await webhook.deliveries.forEndpoint(endpointId, {
  status: 'failed',
  limit: 50,
})
const dead = await webhook.deliveries.forEndpoint(endpointId, { status: 'dead' })
const single = await webhook.deliveries.get(deliveryId)
```

`status` is one of `'pending' | 'delivered' | 'failed' | 'dead'`. Use `'dead'` for a "what's broken right now" dashboard view.

## Schema

`_strav_webhook_endpoints`:

| Column | Type |
|---|---|
| id | UUID PK |
| url | TEXT |
| secret | TEXT |
| events | TEXT[] |
| active | BOOLEAN |
| description | TEXT (nullable) |
| created_at | TIMESTAMPTZ |

`_strav_webhook_deliveries`:

| Column | Type |
|---|---|
| id | UUID PK (also sent as `X-Strav-Delivery`) |
| endpoint_id | UUID FK |
| event | VARCHAR(128) |
| payload | JSONB |
| status | VARCHAR(16) |
| attempts | INT |
| last_error | TEXT |
| response_status | INT |
| response_body | TEXT (truncated) |
| signed_at | TIMESTAMPTZ |
| delivered_at | TIMESTAMPTZ |
| next_retry_at | TIMESTAMPTZ |

Indexes: `(endpoint_id, status, signed_at DESC)`, `(status, next_retry_at) WHERE status = 'pending'`.

## Testing

```typescript
import { Queue } from '@strav/queue'
import { WebhookManager, MemoryWebhookStore } from '@strav/signal'

beforeEach(() => {
  WebhookManager.useStore(new MemoryWebhookStore())
  // Stub the queue so retry scheduling doesn't need a real Queue
  ;(Queue as any).push = async () => 1
  // Stub fetch to avoid real network calls
  globalThis.fetch = async () => new Response('ok', { status: 200 })
})
```

Use `dispatch(..., { immediate: true })` to drive deliveries synchronously without the queue. To exercise the dead-letter path, configure a low `maxAttempts` and call `WebhookManager.deliverNow(id)` repeatedly.

## Out of scope (follow-up)

- Per-event-type filtering DSL (regex patterns, namespace prefixes) — currently exact-match or `'*'`.
- Endpoint-level rate limiting.
- Subscriber UI (admin dashboard for endpoints + delivery history).
- HTTPS-only enforcement for production endpoint URLs.
