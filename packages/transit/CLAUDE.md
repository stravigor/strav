# @strav/transit

Streaming CSV / JSONL import-export pipelines with row-level validation, deduplication, idempotent upsert, and progress reporting. Hand-rolled, zero-dependency CSV reader/writer (RFC 4180 subset).

## Dependencies
- @strav/kernel (peer)
- @strav/database (peer) — only used by `upsertInto()`; the package is fine without a database registered if callers always use `into()`

## Commands
- bun test
- bun run typecheck

## Architecture
- src/csv/reader.ts — `readCsv(source, opts)` → AsyncIterable. Streaming RFC 4180 subset: configurable delimiter/quote, double-quote escaping, CRLF/LF, newlines inside quoted fields, BOM stripping
- src/csv/writer.ts — `writeCsv(rows, sink)` and the lower-level `writeCsvRow(values)`
- src/jsonl/reader.ts, src/jsonl/writer.ts — JSON Lines streaming
- src/pipeline/import_pipeline.ts — `PendingImport` fluent builder; `from() / map() / validate() / dedupBy() / upsertInto() | into() / onProgress() / maxErrors() / run()`
- src/pipeline/export_pipeline.ts — `PendingExport`; `from() / map() / to(sink)`
- src/pipeline/progress.ts — `ProgressReporter` with throttled (default 100 ms) callback
- src/helpers.ts — `transit.import(format)` / `transit.export(format)`

## Pipeline order
For each row pulled from the source:
1. `map(row, i)` — every mapper runs in order; if any returns null/undefined the row is **skipped**
2. `validate(row, i)` — first validator that returns a string ends validation; the row becomes a **row error** (not a skip)
3. `dedupBy(key)` — second sighting of a key is **skipped**
4. **destination**: `upsertInto({ table, conflict, updateColumns?, batchSize? })` runs `INSERT … ON CONFLICT … DO UPDATE` and returns inserted-vs-updated counts via `(xmax = 0)`. `into(callback)` calls the user handler with each batch.

`maxErrors(n)` aborts the run with `TooManyErrorsError` when the count exceeds `n`. Default is `Infinity`.

## Counts on `ImportResult`
- `processed` — every row pulled from the source
- `inserted` — rows that produced a new destination record
- `updated` — rows that updated an existing destination record (upsertInto only)
- `skipped` — rows dropped by `map → null/undefined` or `dedupBy`
- `errors[]` — `{ row, reason, data }`. Validator-rejected rows go here, as do exceptions from `map` / destination

## Conventions
- `from()` accepts `string | Uint8Array | ReadableStream | AsyncIterable`. Bun makes ReadableStreams async-iterable, so the same loop handles both.
- `upsertInto` requires a UNIQUE index on the `conflict` column(s). `INSERT … ON CONFLICT (col) DO UPDATE … RETURNING (xmax = 0) AS inserted` distinguishes inserts from updates per row.
- CSV reader memory: only the current field and current row are buffered. Files are not read fully into memory.
- Progress callbacks are throttled by default (100 ms) — set `throttleMs: 0` via the `ProgressReporter` if you need every tick.

## Testing
- Use `into(batch => …)` to capture batches without a database.
- `readCsv` and `writeCsv` round-trip through each other — useful for canary tests.
