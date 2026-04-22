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

- **Embedded** — in-process SQLite FTS5, zero deps, recommended for self-host / SMB
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
```

## Documentation

See the full [Search guide](../../guides/search.md).

## License

MIT
