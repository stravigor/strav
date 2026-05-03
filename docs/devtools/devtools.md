# Devtools

Application debugging and performance monitoring. Combines a **request inspector** (individual entry capture) with an **APM dashboard** (pre-aggregated metrics) — think Laravel Telescope + Laravel Pulse in one package.

Two modes:

- **Inspector** — captures individual requests, queries, exceptions, logs, and jobs. Every entry is stored in full and grouped into batches so you can trace a single request across all its queries, logs, and side effects.
- **Metrics** — records pre-aggregated performance data (slow requests, slow queries) in time buckets for at-a-glance monitoring without scanning raw entries.

Both modes feed into a built-in SPA dashboard served at `/_devtools`.

## Installation

```bash
bun add @strav/devtools
bun strav install devtools
```

The `install` command copies files into your project:

- `config/devtools.ts` — toggle collectors, recorders, thresholds.
- `database/schemas/devtools_entries.ts` — the entries table schema.
- `database/schemas/devtools_aggregates.ts` — the aggregates table schema.

## Setup

### Register the provider

```typescript
import { DevtoolsProvider } from '@strav/devtools'

app.use(new DevtoolsProvider())
```

That's it. The provider automatically:

- Registers `DevtoolsManager` as a singleton
- Creates the storage tables
- Adds the request-tracking middleware to the router
- Mounts the dashboard at `/_devtools`
- Tears down collectors on shutdown

It depends on the `database` provider.

Options:

| Option | Default | Description |
|--------|---------|-------------|
| `ensureTables` | `true` | Auto-create the entries and aggregates tables |
| `middleware` | `true` | Auto-register the request-tracking middleware on the router |
| `dashboard` | env-aware | Auto-register the dashboard routes at `/_devtools`. **Defaults to ON only when `app.env` is `local`/`development`/`test`**; in any other environment (including unset, which defaults to `production`) the dashboard does NOT mount unless you pass `dashboard: true` explicitly. Pass `false` to skip registration entirely. |
| `guard` | — | Custom auth guard for the dashboard (see [Dashboard auth](#dashboard-auth)) |

To add a custom dashboard auth guard:

```typescript
app.use(new DevtoolsProvider({
  guard: (ctx) => ctx.get('user')?.isAdmin === true,
}))
```

To disable auto-registration of middleware or dashboard (for manual control):

```typescript
app.use(new DevtoolsProvider({ middleware: false, dashboard: false }))
```

### Manual setup

If you prefer full control over middleware and route placement:

```typescript
import DevtoolsManager from '@strav/devtools'
import { devtools } from '@strav/devtools'
import { registerDashboard } from '@strav/devtools/dashboard/routes'

// Register and resolve the manager
app.singleton(DevtoolsManager)
app.resolve(DevtoolsManager)

// Create tables
await devtools.ensureTables()
// Or via CLI: bun strav devtools:setup

// Add request-tracking middleware
router.use(devtools.middleware())

// Mount the dashboard
registerDashboard(router)
```

The middleware captures request/response data, sets a batch ID on the context, and triggers query collection via a SQL proxy. All other collectors (exceptions, logs, jobs) activate automatically through Emitter events.

### Configure

Edit `config/devtools.ts`:

```typescript
import { env } from '@strav/kernel'

export default {
  enabled: env('DEVTOOLS_ENABLED', 'true').bool(),

  routes: {
    aliases: {
      dashboard: 'devtools.dashboard',  // Dashboard routes
      api: 'devtools.api'              // API routes
    },
    subdomain: undefined               // Optional subdomain
  },

  storage: {
    pruneAfter: 24, // hours
  },

  collectors: {
    request: { enabled: true, sizeLimit: 64 },
    query: { enabled: true, slow: 100 },
    exception: { enabled: true },
    log: { enabled: true, level: 'debug' },
    job: { enabled: true },
  },

  recorders: {
    slowRequests: { enabled: true, threshold: 1000, sampleRate: 1.0 },
    slowQueries: { enabled: true, threshold: 1000, sampleRate: 1.0 },
  },
}
```

Set `DEVTOOLS_ENABLED=false` in production to disable all collection with zero overhead.

### Configuration reference

| Key | Default | Description |
|-----|---------|-------------|
| `enabled` | `true` | Whether to enable all devtools collection |
| `routes.aliases.dashboard` | `'devtools.dashboard'` | Route alias prefix for dashboard routes |
| `routes.aliases.api` | `'devtools.api'` | Route alias prefix for API routes |
| `routes.subdomain` | `undefined` | Optional subdomain for devtools routes |
| `storage.pruneAfter` | `24` | Hours after which to delete old entries |
| `collectors.*` | varies | Collector-specific configuration |
| `recorders.*` | varies | Recorder-specific configuration |

## Collectors

Collectors capture individual events and store them as entries.

### Request

Middleware-based. Captures method, path, status, duration, memory usage, request/response headers, and IP. Sensitive headers and body fields are automatically redacted before storage — see [Redaction](#redaction).

Tags: `status:<code>`, `slow` (if >1000ms), `user:<id>` (if authenticated).

```typescript
collectors: {
  request: {
    enabled: true,
    sizeLimit: 64,
    // App-specific keys to add to the redaction deny-list (extends defaults)
    redactKeys: ['x-internal-tenant', 'x-employee-id'],
  },
}
```

The `sizeLimit` option (in KB) controls the maximum body size captured. The `redactKeys` option appends to the default deny-list (which already covers `authorization`, `cookie`, `x-api-key`, `x-auth-token`, `x-csrf-token`, `proxy-authorization`, plus body fields named `password`, `token`, `secret`, `api_key`, etc.).

### Query

Intercepts SQL queries by proxying the `Bun.sql` connection. Captures query text, bindings, duration, and a `familyHash` for grouping similar queries. Queries to devtools' own tables (`_strav_devtools_*`) are excluded.

Tags: `slow` (if exceeding threshold).

```typescript
collectors: {
  query: { enabled: true, slow: 100 },
}
```

The `slow` option (in ms) marks queries above this duration.

### Exception

Listens to `http:error` Emitter events. Captures error class, message, stack trace (first 20 lines), and request context (path, method). Uses `familyHash` to group occurrences of the same error.

Tags: error class name (e.g. `TypeError`).

### Log

Listens to `log:entry` Emitter events. Filters by minimum level. The structured `context` object on each entry is passed through `redact()` before storage — see [Redaction](#redaction).

```typescript
collectors: {
  log: {
    enabled: true,
    level: 'debug',
    // App-specific keys to add to the redaction deny-list
    redactKeys: ['internalCode'],
  },
}
```

Supported levels (lowest to highest): `trace`, `debug`, `info`, `warn`, `error`, `fatal`. Setting `level: 'info'` captures `info`, `warn`, `error`, and `fatal` — not `trace` or `debug`.

Tags: level name. Entries at `error` or `fatal` also get the `error` tag.

### Job

Listens to `queue:dispatched`, `queue:processed`, and `queue:failed` Emitter events. Captures job name, queue, status, duration, and error message (for failures).

Tags: job name, status (`dispatched`, `processed`, `failed`).

## Recorders

Recorders aggregate metrics into time buckets for the dashboard. They don't store individual entries — they update counters and extreme values.

### Slow Requests

Records requests exceeding the threshold. Aggregates: `count`, `max`.

```typescript
recorders: {
  slowRequests: { enabled: true, threshold: 1000, sampleRate: 1.0 },
}
```

### Slow Queries

Records queries exceeding the threshold. Normalizes SQL text (replaces string literals and `$N` parameters) for consistent grouping. Aggregates: `count`, `max`.

```typescript
recorders: {
  slowQueries: { enabled: true, threshold: 1000, sampleRate: 1.0 },
}
```

### sampleRate

Both recorders support a `sampleRate` option (0.0 to 1.0). At `1.0`, every event is recorded. At `0.5`, roughly half are sampled. Useful for high-traffic applications.

## Batch correlation

Every request gets a unique `batchId`. All entries produced during that request — the request itself, its queries, log entries, and exceptions — share the same `batchId`. The dashboard detail view shows all related entries.

Downstream code can read the batch ID:

```typescript
const batchId = ctx.get<string>('_devtools_batch_id')
```

## devtools helper

The `devtools` helper provides the primary convenience API:

```typescript
import { devtools } from '@strav/devtools'
```

### Querying entries

```typescript
// List recent entries (all types)
const entries = await devtools.entries()

// Filter by type
const requests = await devtools.entries('request', 50)
const queries = await devtools.entries('query', 100, 0)

// Find by UUID
const entry = await devtools.find('550e8400-e29b-41d4-a716-446655440000')

// Find all entries in a batch
const batch = await devtools.batch(entry.batchId)

// Search by tag
const slow = await devtools.byTag('slow')
const user42 = await devtools.byTag('user:42')

// Count
const total = await devtools.count()
const exceptions = await devtools.count('exception')
```

### Querying metrics

```typescript
import { PERIODS } from '@strav/devtools'

// Time-series data
const hourly = await devtools.aggregates('slow_request', PERIODS.ONE_HOUR, 'count')
const daily = await devtools.aggregates('slow_query', PERIODS.ONE_DAY, 'max')

// Top offenders
const topSlow = await devtools.topKeys('slow_request', PERIODS.ONE_HOUR, 'count', 10)
```

### Pruning

```typescript
// Prune entries older than the configured pruneAfter value
const { entries, aggregates } = await devtools.prune()

// Or specify hours explicitly
const result = await devtools.prune(48)
```

## Dashboard

The built-in SPA dashboard is served at `/_devtools` and provides seven views:

**Inspector views:**

| View | Shows |
|------|-------|
| Requests | Method, path, status, duration, time |
| Queries | SQL preview, duration, slow flag |
| Exceptions | Error class, message, request path |
| Logs | Level, message, timestamp |
| Jobs | Name, status, queue, duration |

**Metrics views:**

| View | Shows |
|------|-------|
| Slow Requests | Top endpoints by count and max duration |
| Slow Queries | Top queries by count and max duration |

Clicking any entry opens a detail view with full content and all related batch entries. The dashboard auto-refreshes every 5 seconds.

### Dashboard auth

By default, the dashboard is only accessible in `development` and `local` environments. In production, it returns 403.

To allow access in production, pass a custom guard:

```typescript
import { registerDashboard } from '@strav/devtools/dashboard/routes'

registerDashboard(router, (ctx) => {
  const user = ctx.get('user')
  return user?.isAdmin === true
})
```

The guard receives the request context and returns `true` or `false` (or a Promise). It's called on every request to the `/_devtools` prefix.

You can also use the middleware directly:

```typescript
import { dashboardAuth } from '@strav/devtools/dashboard/middleware'

router.group({
  prefix: '/_devtools',
  middleware: [dashboardAuth((ctx) => ctx.get('user')?.isAdmin)]
}, (r) => {
  // custom routes
})
```

## CLI commands

### devtools:setup

Create the storage tables (idempotent):

```bash
bun strav devtools:setup
```

### devtools:prune

Delete old entries and aggregates:

```bash
bun strav devtools:prune
bun strav devtools:prune --hours 48
```

**Options:**
- `--hours <hours>` — Delete data older than this many hours (default: `24`).

## Dashboard routes and API

The dashboard includes both frontend routes and a REST API, organized with configurable route aliases for easy programmatic access.

### Dashboard routes (`devtools.dashboard` alias)

| Path | Route Name | Description |
|------|-----------|-------------|
| `/_devtools` | `devtools.dashboard.home` | Main dashboard SPA |

### API routes (`devtools.api` alias)

The dashboard mounts a REST API under `/_devtools/api/`:

| Method | Path | Route Name | Description |
|--------|------|-----------|-------------|
| GET | `/api/entries` | `devtools.api.entries` | List entries. Query: `type`, `limit`, `offset` |
| GET | `/api/entries/:uuid` | `devtools.api.entry` | Single entry by UUID |
| GET | `/api/entries/:uuid/batch` | `devtools.api.entry_batch` | All entries in the same batch |
| GET | `/api/entries/tag/:tag` | `devtools.api.entries_by_tag` | Entries by tag. Query: `limit` |
| GET | `/api/metrics/:type` | `devtools.api.metrics` | Time-series aggregates. Query: `period`, `aggregate`, `limit` |
| GET | `/api/metrics/:type/top` | `devtools.api.metrics_top` | Top keys by value. Query: `period`, `aggregate`, `limit` |
| GET | `/api/stats` | `devtools.api.stats` | Entry counts by type |
| DELETE | `/api/entries` | `devtools.api.prune_entries` | Prune old data. Query: `hours` |

### Using named routes

With route aliases configured, you can access the devtools API programmatically:

```typescript
import { route, routeUrl } from '@strav/http'

// Get recent entries
const entries = await route('devtools.api.entries', {
  params: { type: 'request', limit: 50 }
})

// Get a specific entry
const entry = await route('devtools.api.entry', {
  params: { uuid: '550e8400-e29b-41d4-a716-446655440000' }
})

// Get all entries in a batch
const batchEntries = await route('devtools.api.entry_batch', {
  params: { uuid: entry.uuid }
})

// Get entries by tag
const slowEntries = await route('devtools.api.entries_by_tag', {
  params: { tag: 'slow' }
})

// Get metrics data
const metrics = await route('devtools.api.metrics', {
  params: { type: 'slow_request' },
  query: { period: '3600', aggregate: 'count', limit: '24' }
})

// Get top performers
const topQueries = await route('devtools.api.metrics_top', {
  params: { type: 'slow_query' },
  query: { period: '3600', aggregate: 'count', limit: '10' }
})

// Get stats
const stats = await route('devtools.api.stats')

// Prune old data
await route('devtools.api.prune_entries', {
  method: 'DELETE',
  query: { hours: '48' }
})

// Generate dashboard URL
const dashboardUrl = routeUrl('devtools.dashboard.home')
```

### Custom route aliases

You can customize the route aliases in your devtools configuration:

```typescript
// config/devtools.ts
export default {
  routes: {
    aliases: {
      dashboard: 'debug.dashboard',  // Routes: debug.dashboard.home
      api: 'debug.api'              // Routes: debug.api.entries, etc.
    }
  }
}

// Or mount on a subdomain
export default {
  routes: {
    subdomain: 'devtools'  // Accessible at devtools.example.com
  }
}
```

## Entry types

```typescript
type EntryType =
  | 'request'
  | 'query'
  | 'exception'
  | 'log'
  | 'job'
  | 'cache'     // reserved for future use
  | 'mail'      // reserved for future use
  | 'event'     // reserved for future use
  | 'schedule'  // reserved for future use
```

## Aggregate functions

```typescript
type AggregateFunction = 'count' | 'min' | 'max' | 'sum' | 'avg'
```

## Aggregate periods

```typescript
import { PERIODS } from '@strav/devtools'

PERIODS.ONE_HOUR    // 3600
PERIODS.SIX_HOURS   // 21600
PERIODS.ONE_DAY     // 86400
PERIODS.SEVEN_DAYS  // 604800
```

## Database tables

### _strav_devtools_entries

| Column | Type | Description |
|--------|------|-------------|
| `id` | `bigserial` | Primary key |
| `uuid` | `uuid` | Unique entry identifier |
| `batch_id` | `uuid` | Groups entries from the same request |
| `type` | `varchar(30)` | Entry type (request, query, etc.) |
| `family_hash` | `varchar(64)` | Groups similar entries (same error, same query) |
| `content` | `jsonb` | Full entry payload |
| `tags` | `text[]` | Searchable string tags |
| `created_at` | `timestamptz` | When the entry was recorded |

Indexes: `batch_id`, `(type, created_at DESC)`, `family_hash` (partial, where not null).

### _strav_devtools_aggregates

| Column | Type | Description |
|--------|------|-------------|
| `id` | `bigserial` | Primary key |
| `bucket` | `int` | Unix timestamp of the time bucket start |
| `period` | `int` | Bucket size in seconds |
| `type` | `varchar(30)` | Metric type (slow_request, slow_query) |
| `key` | `text` | Grouping key (e.g. `GET /api/users`) |
| `aggregate` | `varchar(10)` | Function (count, min, max, sum, avg) |
| `value` | `numeric(20,2)` | Aggregated value |
| `count` | `int` | Number of samples in this bucket |

Unique constraint: `(bucket, period, type, aggregate, key)`.

## Redaction

Captured payloads are scrubbed before they hit storage. Both `RequestCollector` (request and response headers) and `LogCollector` (log `context` object) pipe values through `redact()` from `@strav/kernel` — see the [helpers doc](../kernel/helpers.md#redact-secret-redaction).

The default deny-list catches:

- HTTP auth headers: `authorization`, `cookie`, `set-cookie`, `x-api-key`, `x-auth-token`, `x-csrf-token`, `proxy-authorization`
- Common secret fields: `password`, `passwd`, `pwd`, `token`, `access_token`, `refresh_token`, `id_token`, `secret`, `client_secret`, `api_key`, `apikey`
- Session identifiers: `session`, `session_id`, `sessionid`
- Plus common casing variants of all of the above (case-insensitive exact-match)

Matched values are replaced with the literal string `[REDACTED]`. Matching walks nested plain objects and arrays; `Date`, `Buffer`, typed arrays, and class instances pass through unchanged.

To extend the deny-list with app-specific names, pass `redactKeys` to the collector:

```typescript
collectors: {
  request: { enabled: true, redactKeys: ['x-internal-tenant'] },
  log: { enabled: true, redactKeys: ['internalCode'] },
}
```

Note: stack traces in `ExceptionCollector` are NOT redacted — stack lines are free-form text that key-based redaction can't reach into. Application code must avoid putting secrets in error messages.

## API rate limit + access events

The `/_devtools/api/*` endpoints are rate-limited (120 requests / 60 s, keyed by client IP via `X-Forwarded-For` / `X-Real-IP`) and emit `devtools:access` Emitter events for every call. Wire the event to `@strav/audit` to track who hit the inspector — useful when the dashboard is mounted on a non-local environment behind a custom guard:

```typescript
import { Emitter } from '@strav/kernel'
import { audit } from '@strav/audit'

Emitter.on('devtools:access', e => {
  audit
    .by(e.actor ?? { type: 'system', id: 'unknown' })
    .on('devtools', e.path)
    .action('viewed')
    .meta({ method: e.method, ip: e.ip })
    .log()
})
```

The access middleware short-circuits via `Emitter.listenerCount('devtools:access')` — zero cost when no listener is wired.

## Zero-cost when disabled

All core event emissions use a `listenerCount()` guard:

```typescript
if (Emitter.listenerCount('log:entry') === 0) return
```

When devtools is not installed or `enabled: false`, there are no listeners registered, so the guard short-circuits before allocating any event objects. The SQL proxy is also skipped entirely when disabled.

## Error handling

```typescript
import { DevtoolsError } from '@strav/devtools'
```

`DevtoolsError` extends `ConfigurationError` from core. It's thrown when DevtoolsManager is accessed before being resolved through the container.

## Testing

Disable devtools in tests to avoid recording test traffic:

```env
# .env.test
DEVTOOLS_ENABLED=false
```

Or don't resolve `DevtoolsManager` in your test bootstrap — collectors and recorders simply won't activate, and the `listenerCount()` guards ensure zero overhead.

## Full setup example

```typescript
import { app } from '@strav/kernel'
import { DevtoolsProvider } from '@strav/devtools'

app.use(new DevtoolsProvider({
  guard: (ctx) => {
    if (process.env.NODE_ENV === 'production') {
      const user = ctx.get('user')
      return user?.isAdmin === true
    }
    return true
  },
}))

await app.start()
```
