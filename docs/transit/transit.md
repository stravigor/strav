# Transit

Streaming CSV / JSONL import-export pipeline with row-level validation, deduplication, idempotent upsert, and progress reporting. Hand-rolled, zero-dependency CSV reader/writer (RFC 4180 subset).

Use it for "customer wants to import their existing contacts from a CSV", "export a filtered query as a download", or anywhere you need a robust streaming data pipeline.

## Installation

```bash
bun add @strav/transit
```

`@strav/transit` is a library — no service provider, no boot step. Import and call.

> The `@strav/database` peer dependency is only used when you call `.upsertInto(...)`. If your destination is always `into(callback)`, the database doesn't need to be configured.

## Quick start

```typescript
import { transit } from '@strav/transit'

const result = await transit
  .import('csv')
  .from(Bun.file('contacts.csv').stream())
  .map(row => ({
    email: row.Email.trim().toLowerCase(),
    name: row.Name,
    company: row.Company || null,
  }))
  .validate(row => (row.email.includes('@') ? null : 'invalid email'))
  .dedupBy('email')
  .upsertInto({ table: 'contacts', conflict: 'email' })
  .onProgress(p => console.log(`${p.processed} / ${p.inserted + p.updated} written`))
  .maxErrors(100)
  .run()

// → { processed: 2480, inserted: 2300, updated: 175, skipped: 5, errors: [...] }
```

```typescript
await transit
  .export('csv')
  .from(Lead.query().where('status', 'qualified'))
  .map(lead => ({ Email: lead.email, Name: lead.name, Score: lead.score }))
  .to(response.body)
```

## The pipeline

For each row pulled from the source, transit runs:

```
read & decode
  → map(row, i)              [optional, may be chained]
  → validate(row, i)         [optional, may be chained]
  → dedupBy(key)             [optional]
  → destination              [upsertInto OR into]
```

### `from(source)`

Sources can be:

- a `string` (the entire CSV/JSONL contents)
- a `Uint8Array`
- a `ReadableStream<Uint8Array>` (e.g. from `Bun.file(path).stream()`, `Request.body`, or `fetch().body`)
- any `AsyncIterable<Uint8Array | string>`

Memory: only the current field and current row are buffered, even for streaming sources. The full file never sits in memory.

### `map(fn)`

Transform a raw row into the typed shape your application uses. Multiple `.map()` calls chain in order. Returning `null` or `undefined` **skips** the row (counts as `skipped`):

```typescript
.map(row => row.Status === 'archived' ? null : row)
```

### `validate(fn)`

Return a string to reject the row with that reason — it becomes a `RowError` (counts as `errors`, not `skipped`). Return `null` / `undefined` / `void` to accept.

```typescript
.validate(row => {
  if (!row.email) return 'email required'
  if (!row.email.includes('@')) return 'email invalid'
})
```

Multiple `.validate()` calls chain in order; the first one that returns a reason ends validation.

`.run()` emits a `console.warn` once when no validators are registered — the import will write every row unchecked, which is rarely the intent. Pass an explicit `.validate(() => null)` if you genuinely want unvalidated imports.

### `dedupBy(key | extractor)`

Drop the second (and subsequent) rows with the same key:

```typescript
.dedupBy('email')                          // column name
.dedupBy(row => `${row.email}|${row.tenantId}`)  // composite key
```

Deduplication is **within the import run**, not against the database. (For "don't insert if already exists in the table", use `upsertInto` — `ON CONFLICT` handles it.)

The dedup `Set` is held in memory and grows for every distinct key seen, so adversarial / unbounded sources can exhaust RAM. The pipeline aborts with `DedupKeyLimitError` when the set crosses `maxDedupKeys()` — default **1,000,000** (≈100 MB at 100 bytes per key).

```typescript
.dedupBy('email').maxDedupKeys(500_000)   // tighten for tighter memory budgets
.dedupBy('email').maxDedupKeys(Infinity)   // opt out (explicit acknowledgement)
```

For data sets where uniqueness is genuinely unbounded, prefer DB-native deduplication (UNIQUE index + `upsertInto`, or `SELECT DISTINCT ON`).

### Destination

#### `upsertInto({ table, conflict, updateColumns?, batchSize? })`

PostgreSQL `INSERT … ON CONFLICT (col) DO UPDATE` against the target table. Requires a UNIQUE / PRIMARY KEY index on the conflict column(s). Auto-detects column order from the first observed row.

```typescript
.upsertInto({
  table: 'contacts',
  conflict: 'email',                                   // single column
  // conflict: ['tenant_id', 'email'],                  // composite key
  // updateColumns: ['name', 'company', 'updated_at'], // default: all non-conflict
  // batchSize: 1000,                                  // default: 500
})
```

`.run()` queries `pg_indexes` at start-up time and refuses to proceed when no UNIQUE / PRIMARY KEY index covers the conflict columns — without one, `ON CONFLICT` silently degrades to plain INSERT and every re-run duplicates rows. Create the index first:

```sql
CREATE UNIQUE INDEX contacts_email_uq ON "contacts" ("email");
-- or for composite keys:
CREATE UNIQUE INDEX contacts_tenant_email_uq ON "contacts" ("tenant_id", "email");
```

Returns inserted-vs-updated counts via `RETURNING (xmax = 0) AS inserted` (the Postgres trick for "was this an INSERT or did it UPDATE?").

#### `into(handler)`

Custom destination — receives one batch at a time. Use this when the target isn't a Postgres table (search index, queue, external API, in-memory test):

```typescript
.into(async batch => {
  for (const row of batch) {
    await searchIndex.upsert(row.id, row)
  }
})
```

Mutually exclusive with `upsertInto`.

### `onProgress(callback)`

Subscribe to throttled progress updates (default 100 ms gap):

```typescript
.onProgress(p => sse.send('import.progress', p))
// ProgressReport: { processed, inserted, updated, skipped, errors, done }
```

The callback fires once at the end with `done: true` regardless of throttling.

### `maxErrors(n)`

Abort the import with `TooManyErrorsError` once accumulated row errors exceed `n`. Default: `Infinity` (collect all errors and return them on the result).

```typescript
.maxErrors(50)
```

### `batch(size)`

Override the batch size used for both `into(handler)` calls and `upsertInto`'s INSERT statements. Default: 500.

## Counts on `ImportResult`

| Field | Meaning |
|---|---|
| `processed` | Every row pulled from the source. |
| `inserted` | Rows that produced a new destination record. |
| `updated` | Rows that updated an existing destination record (upsertInto only). |
| `skipped` | Rows dropped by `map → null/undefined` or by `dedupBy`. |
| `errors[]` | `{ row, reason, data }`. Validator-rejected rows AND exceptions raised inside map/destination. |

`processed = inserted + updated + skipped + errors.length` always holds.

## Format options

### CSV

`transit.import('csv')` accepts:

```typescript
.csvOptions({
  delimiter: ',',          // default
  quote: '"',              // default
  header: true,            // first row → headers; emit Record<string, string>
  // header: false         // emit string[]
  // header: ['Email', 'Name']  // explicit headers; first row is data
  skipEmpty: true,         // default — skip lines with no fields
})
```

Or the shortcut for explicit headers:

```typescript
.header(['Email', 'Name'])
```

The reader handles:

- both `\n` and `\r\n` line endings (mixed within a file is fine)
- newlines inside quoted fields (`"line1\nline2"`)
- escaped double quotes inside quoted fields (`"She said ""hi"""` → `She said "hi"`)
- leading UTF-8 BOM (stripped)
- input split across stream chunks at any character (including mid-quote)

Throws `CsvParseError` on unterminated quoted fields.

### JSONL

`transit.import('jsonl')` reads one JSON value per line. Empty lines are skipped. Invalid JSON throws on the offending line — wrap individual rows in `try/catch` via the import pipeline's row-level error handling if you want to tolerate bad lines.

```typescript
await transit
  .import('jsonl')
  .from(Bun.file('events.jsonl').stream())
  .into(batch => processBatch(batch))
  .run()
```

## Export

```typescript
import { transit } from '@strav/transit'

await transit
  .export('csv')
  .from(Lead.query().where('status', 'qualified'))
  .map(lead => ({
    Email: lead.email,
    Name: lead.name,
    Score: lead.score,
    Created: lead.createdAt.toISOString(),
  }))
  .to(response.body)   // any WritableStream or { write(s) }
```

`from()` accepts:

- an array
- an `Iterable` or `AsyncIterable`
- any object exposing `.all()` (e.g. ORM query builders)
- any object exposing `.run()`

Sinks accept:

- a `WritableStream<Uint8Array | string>` (typical for HTTP responses)
- any `{ write(chunk: string): void | Promise<void>; close?(): void | Promise<void> }`

CSV column order is taken from the first row's keys, or from `csvOptions({ columns: [...] })`.

## Common patterns

### HTTP file upload import

```typescript
router.post('/imports/contacts', async ctx => {
  const file = await ctx.request.formData().get('file') as File
  const result = await transit
    .import('csv')
    .from(file.stream())
    .map(row => ({ email: row.Email.toLowerCase(), name: row.Name }))
    .validate(row => row.email.includes('@') ? null : 'invalid email')
    .dedupBy('email')
    .upsertInto({ table: 'contacts', conflict: 'email' })
    .run()

  return ctx.json(result)
})
```

### Background import with live progress (SSE)

```typescript
import { sse } from '@strav/signal'

sse.channel<{ jobId: string }>('import.progress')

Queue.handle('import-contacts', async (job: { url: string; userId: string }) => {
  const file = await fetch(job.url)
  await transit
    .import('csv')
    .from(file.body!)
    .upsertInto({ table: 'contacts', conflict: 'email' })
    .onProgress(p => sse.to('import.progress', { jobId: job.userId }).send(p))
    .run()
})
```

### CSV download endpoint

```typescript
router.get('/export/leads.csv', async ctx => {
  const stream = new TransformStream<string, Uint8Array>({
    transform(chunk, controller) {
      controller.enqueue(new TextEncoder().encode(chunk))
    },
  })
  transit
    .export('csv')
    .from(Lead.query().where('status', 'qualified'))
    .to(stream.writable)
    .catch(err => console.error(err))

  return new Response(stream.readable, {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': 'attachment; filename="leads.csv"',
    },
  })
})
```

### Round-trip a CSV through your domain logic

Useful for migrations and "fix this column" cleanups:

```typescript
await transit
  .import('csv')
  .from(input)
  .map(row => fixupRow(row))
  .into(async batch => {
    for (const row of batch) {
      await transit
        .export('csv')
        .from([row])
        .csvOptions({ writeHeader: false })
        .to(output)
    }
  })
  .run()
```

## Error handling

`RowError`s are accumulated on the result, not thrown:

```typescript
const result = await transit.import('csv').from(...).into(...).run()
for (const err of result.errors) {
  console.warn(`row ${err.row}: ${err.reason}`, err.data)
}
```

Catastrophic errors (source read failure, destination crash) propagate. So does `TooManyErrorsError` once `maxErrors(n)` is exceeded.

## Lower-level building blocks

If you need just the parser or just the writer:

```typescript
import { readCsv, writeCsv, readJsonl, writeJsonl } from '@strav/transit'

for await (const row of readCsv(stream, { header: true })) {
  // ...
}

await writeCsv(rows, sink, { columns: ['Email', 'Score'] })
```

These are the primitives the pipeline builds on. They're intentionally minimal (`AsyncIterable<Record<string, string>>` in, characters out) so you can compose them however the use case requires.

## Testing

Use `into(batch => …)` to capture batches without a database:

```typescript
import { describe, test, expect } from 'bun:test'
import { transit } from '@strav/transit'

test('imports and dedupes contacts', async () => {
  const captured: any[] = []
  const result = await transit
    .import('csv')
    .from('Email,Name\na@x.com,A\nA@X.com,A duplicate\n')
    .map(row => ({ email: row.Email.toLowerCase() }))
    .dedupBy('email')
    .into(batch => { captured.push(...batch) })
    .run()

  expect(result.inserted).toBe(1)
  expect(result.skipped).toBe(1)
  expect(captured).toEqual([{ email: 'a@x.com' }])
})
```

`readCsv` and `writeCsv` round-trip through each other, which is useful for canary tests.

## API reference

### `transit` helper

| Method | Description |
|---|---|
| `transit.import('csv' \| 'jsonl')` | Begin a `PendingImport`. |
| `transit.export('csv' \| 'jsonl')` | Begin a `PendingExport`. |

### `PendingImport`

`from(source)` `.csvOptions(opts)` `.header(cols)` `.map(fn)` `.validate(fn)` `.dedupBy(keyOrFn)` `.upsertInto(target) | .into(handler)` `.onProgress(cb)` `.maxErrors(n)` `.batch(size)` `.run() → ImportResult`

### `PendingExport`

`from(source)` `.map(fn)` `.csvOptions(opts)` `.to(sink) → number` (rows written)

### Standalone helpers

| Function | Description |
|---|---|
| `readCsv(source, opts?)` | Streaming CSV → AsyncIterable. |
| `writeCsv(rows, sink, opts?)` | Stream rows → CSV. Returns row count. |
| `writeCsvRow(values, opts?)` | Single-line serialization (no newline). |
| `readJsonl(source)` | Streaming JSONL → AsyncIterable. |
| `writeJsonl(rows, sink)` | Stream rows → JSONL. Returns row count. |

### Errors

`TransitError`, `TooManyErrorsError`, `CsvParseError` — all exported from the root.

### Types

`ImportResult`, `ProgressReport`, `RowError`, `UpsertTarget`, `CsvReadOptions`, `CsvWriteOptions`, `ReadSource`, `WriteSink` — all exported from the root.
