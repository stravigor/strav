# @strav/search

Full-text search for the [Strav](https://www.npmjs.com/package/@strav/core) framework. Unified API across several engines — including a built-in `embedded` driver that runs in-process with no external service to deploy.

## Install

```bash
bun add @strav/search
bun strav install search
```

Requires `@strav/core` as a peer dependency.

## Setup

```ts
import { SearchProvider } from '@strav/search'

app.use(new SearchProvider())
```

## Searchable Models

```ts
import { searchable } from '@strav/search'

class Post extends searchable(BaseModel) {
  static searchableAs = 'posts'

  toSearchableDocument() {
    return { id: this.id, title: this.title, body: this.body }
  }
}
```

## Usage

```ts
import { search } from '@strav/search'

// Search
const results = await search.query('posts', 'hello world', {
  filters: 'status = published',
  limit: 20,
})

// Manual indexing
await search.index('posts', [{ id: 1, title: 'Hello' }])
await search.delete('posts', ['1'])
```

## Drivers

- **Embedded** — in-process SQLite FTS5, zero deps, recommended for self-host / SMB (~50k–500k docs)
- **Postgres FTS** — tsvector + GIN + pg_trgm, drop-in upgrade for higher volume (1M–100M docs)
- **Meilisearch** — fast, typo-tolerant, self-hosted
- **Typesense** — open-source, instant search
- **Algolia** — hosted search-as-a-service
- **Null** — no-op driver for testing

### Embedded driver

Runs entirely inside your app process using `bun:sqlite`'s FTS5 engine — no Meilisearch/Typesense container to run. Each index is a single `.sqlite` file in the configured data directory.

Features:

- BM25 ranking with per-field weights (via `searchableAttributes` ordering)
- Prefix (`type*`), phrase (`"quick brown fox"`), negation (`-foo`), required (`+foo`)
- Porter stemmer for English morphology
- Typo tolerance (Levenshtein-1) on the fly, configurable
- Highlighted snippets with `<mark>` tags
- Object-form filters with equality, `in`, and comparison operators

Limitations for v1:

- English stemming only (other languages are tokenised but not stemmed)
- One writer at a time per index file (SQLite WAL — concurrent reads are fine)
- Object-form filters only; raw SQL filter strings are rejected
- Index settings changes require recreating the index

Configuration:

```ts
// config/search.ts
embedded: {
  driver: 'embedded',
  path: env('SEARCH_PATH', './storage/search'),   // directory of .sqlite files
  synchronous: 'NORMAL',                            // 'OFF' | 'NORMAL' | 'FULL'
  typoTolerance: 'auto',                            // 'off' | 'auto' | { minTokenLength, maxDistance }
}
```

Select it as the default with `SEARCH_DRIVER=embedded`.

### Postgres FTS driver

Higher-volume tier (1M–100M docs per index) backed by your existing Postgres. Same `SearchEngine` interface as the embedded driver — drop-in swap by changing one config line.

Features:

- BM25-shaped ranking via `ts_rank_cd(fts, q, 1 | 32)` with per-field weights (`A`/`B`/`C`/`D`)
- `websearch_to_tsquery` Google-style queries plus prefix (`type*`)
- Multi-language stemming via Postgres text-search configurations (`english`, `french`, ...) — set per index
- Levenshtein-near typo tolerance via `pg_trgm` + optional `fuzzystrmatch`
- `<mark>`-highlighted snippets via `ts_headline`, computed only on the top-K to keep latency bounded
- Object-form filters with `eq`/`neq`/`gt`/`gte`/`lt`/`lte`/`in`/`nin` against generated typed columns
- One table per index in a dedicated `strav_search` schema (auto-created)

Requirements:

- Postgres ≥ 15
- `pg_trgm` extension (auto-`CREATE EXTENSION IF NOT EXISTS` on first use; superuser or owner privilege)
- `fuzzystrmatch` is optional — if present, typo expansion re-ranks trigram candidates with bounded Levenshtein for higher precision

Configuration:

```ts
postgres: {
  driver: 'postgres-fts',
  // Optional: pass a Bun SQL handle. Falls back to @strav/database's Database.raw.
  // connection: db.sql,
  schema: env('SEARCH_PG_SCHEMA', 'strav_search'),
  language: env('SEARCH_PG_LANGUAGE', 'english'),
  typoTolerance: env('SEARCH_TYPO_TOLERANCE', 'auto'),
  workMem: env('SEARCH_PG_WORK_MEM', '64MB'),
  gin: { fastupdate: false },  // better tail latency
}
```

Select it with `SEARCH_DRIVER=postgres`.

Limitations for v1:

- Settings change (e.g. add a new searchable attribute) requires `bun strav search:rebuild <model>`. Tier picked by row count: in-place UPDATE under 100k, batched UPDATE up to 10M, dual-table swap deferred to v1.1 with a clear error above 10M.
- Adding a new `filterableAttribute` on an existing large table currently rewrites the whole heap (`ALTER TABLE ADD COLUMN ... GENERATED ... STORED`). Plan an offline window for big tables in v1.
- One language per index — mixed-locale indexes deferred.
- Object-form filters only; raw SQL filter strings rejected.

Ranking note: `ts_rank_cd` is BM25-*shaped* (length normalisation + bounded mapping), not strict BM25. For the size and shape of corpora the driver targets, the difference is small in practice; the embedded driver remains the answer when strict BM25 matters and the corpus fits.

Model example with per-field weights (column order determines BM25 weight — title first = highest):

```ts
class Ticket extends searchable(BaseModel) {
  static searchableSettings() {
    return {
      searchableAttributes: ['subject', 'body'],
      filterableAttributes: ['status', 'priority'],
      sortableAttributes: ['priority', 'created_at'],
    }
  }
}
```

#### Replacing Postgres `tsvector`

If you've been using raw `tsvector` columns, the embedded driver gives you better ranking, typo tolerance, and highlighted snippets without adding a network service. The migration is roughly:

```ts
// Before: hand-rolled tsvector query
const rows = await db.sql`
  SELECT id, subject, ts_rank_cd(fts, q) AS rank
  FROM tickets, websearch_to_tsquery('english', ${q}) q
  WHERE fts @@ q ORDER BY rank DESC LIMIT 20
`

// After: searchable() + embedded driver
const results = await Ticket.search(q, {
  perPage: 20,
  attributesToHighlight: ['subject', 'body'],
})
```

You run `bun strav search:import Ticket` once to populate the index, then model events keep it up to date.

## CLI

```bash
bun strav search:import <model>      # Import all records for a model
bun strav search:flush <model>       # Flush all documents from an index
bun strav search:optimize <model>    # (embedded) Merge FTS5 segments; run periodically
bun strav search:rebuild <model>     # (postgres) Recompute fts after settings change
```

## Documentation

See the full [Search guide](../../guides/search.md).

## License

MIT
