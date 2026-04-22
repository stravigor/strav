# Search

Full-text search with a unified API across multiple engines. Built-in drivers for **Embedded** (in-process SQLite FTS5, no external service), **Meilisearch**, **Typesense**, and **Algolia**. Custom drivers can be added via `extend()`.

The `searchable()` mixin integrates search directly into your ORM models — upsert on save, remove on delete, query with a single static method.

> **Picking a driver.** If you want zero ops surface and a one-process self-host, start with **embedded**. If you already run Meilisearch/Typesense, or you need a hosted service, use one of the network drivers. The API surface is identical across drivers — you can switch later by changing one config line.

## Installation

```bash
bun add @strav/search
bun strav install search
```

The `install` command copies `config/search.ts` into your project. The file is yours to edit.

## Setup

### 1. Register SearchManager

#### Using a service provider (recommended)

```typescript
import { SearchProvider } from '@strav/search'

app.use(new SearchProvider())
```

The `SearchProvider` registers `SearchManager` as a singleton. It depends on the `config` provider.

#### Manual setup

```typescript
import SearchManager from '@strav/search'

app.singleton(SearchManager)
app.resolve(SearchManager)
```

### 2. Configure drivers

Edit `config/search.ts`:

```typescript
import { env } from '@strav/kernel'

export default {
  default: env('SEARCH_DRIVER', 'meilisearch'),
  prefix: env('SEARCH_PREFIX', ''),

  drivers: {
    embedded: {
      driver: 'embedded',
      // Directory holding per-index `.sqlite` files. Use ':memory:' for tests.
      path: env('SEARCH_PATH', './storage/search'),
      // SQLite synchronous pragma: 'OFF' | 'NORMAL' | 'FULL'.
      synchronous: env('SEARCH_SYNCHRONOUS', 'NORMAL'),
      // 'off' | 'auto' | { minTokenLength, maxDistance }
      typoTolerance: env('SEARCH_TYPO_TOLERANCE', 'auto'),
    },

    meilisearch: {
      driver: 'meilisearch',
      host: env('MEILISEARCH_HOST', 'localhost'),
      port: env('MEILISEARCH_PORT', '7700').int(),
      apiKey: env('MEILISEARCH_KEY', ''),
    },

    typesense: {
      driver: 'typesense',
      host: env('TYPESENSE_HOST', 'localhost'),
      port: env('TYPESENSE_PORT', '8108').int(),
      apiKey: env('TYPESENSE_KEY', ''),
      protocol: 'http',
    },

    algolia: {
      driver: 'algolia',
      appId: env('ALGOLIA_APP_ID', ''),
      apiKey: env('ALGOLIA_SECRET', ''),
    },
  },
}
```

### 3. Set environment variables

For the embedded driver (no external service):

```env
SEARCH_DRIVER=embedded
SEARCH_PATH=./storage/search
```

For Meilisearch:

```env
SEARCH_DRIVER=meilisearch
MEILISEARCH_HOST=localhost
MEILISEARCH_PORT=7700
MEILISEARCH_KEY=your-master-key
```

## Searchable mixin

Add full-text search to any model with the `searchable()` mixin:

```typescript
import BaseModel from '@strav/database'
import { searchable } from '@strav/search'

class Article extends searchable(BaseModel) {
  declare id: number
  declare title: string
  declare body: string
  declare status: string

  static tableName = 'articles'

  static searchableAs() {
    return 'articles'
  }

  toSearchableArray() {
    return { id: this.id, title: this.title, body: this.body }
  }

  shouldBeSearchable() {
    return this.status === 'published'
  }
}
```

Works with `compose()` for multiple mixins:

```typescript
import { compose } from '@strav/kernel'
import { softDeletes } from '@strav/database'

class Article extends compose(BaseModel, softDeletes, searchable) {
  // ...
}
```

### searchableAs

Returns the index name. Defaults to the model's `tableName`. Override to customize:

```typescript
static searchableAs() {
  return 'blog_articles'
}
```

### toSearchableArray

Converts a model instance to a document for the search index. By default, returns all own properties that don't start with `_`. Override to control which fields are indexed:

```typescript
toSearchableArray() {
  return {
    id: this.id,
    title: this.title,
    body: this.body,
    author_name: this.authorName,
  }
}
```

### shouldBeSearchable

Controls whether a specific instance should be indexed. Defaults to `true`. Override to conditionally exclude records:

```typescript
shouldBeSearchable() {
  return this.status === 'published'
}
```

### searchableSettings

Configure index settings (searchable, filterable, sortable attributes). Returns `undefined` by default, which uses engine defaults:

```typescript
static searchableSettings() {
  return {
    searchableAttributes: ['title', 'body'],
    filterableAttributes: ['status', 'category_id'],
    sortableAttributes: ['created_at', 'title'],
  }
}
```

## Searching

### From a model

```typescript
const results = await Article.search('typescript generics')
```

The result object:

```typescript
{
  hits: [
    { document: { id: 1, title: 'TS Guide', body: '...' }, highlights: { ... } },
    { document: { id: 2, title: 'Generics 101', body: '...' } },
  ],
  totalHits: 2,
  page: 1,
  perPage: 20,
  processingTimeMs: 3,
}
```

### Search options

```typescript
const results = await Article.search('typescript', {
  filter: { status: 'published' },
  sort: ['created_at:desc'],
  page: 2,
  perPage: 10,
  attributesToRetrieve: ['id', 'title'],
  attributesToHighlight: ['title', 'body'],
})
```

Filters can also be passed as an engine-native string:

```typescript
// Meilisearch filter syntax
await Article.search('test', { filter: 'status = published AND category_id = 3' })

// Typesense filter syntax
await Article.search('test', { filter: 'status:=published' })
```

> The **embedded** driver only accepts the object form — raw filter strings are rejected to avoid SQL injection. It supports operator objects: `{ priority: { gte: 3, lt: 8 }, status: { in: ['open', 'pending'] } }` (operators: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `nin`). Each filtered field must be listed in `filterableAttributes`.

## Auto-indexing

Register event listeners so models are automatically indexed on create/update and removed on delete:

```typescript
Article.bootSearch('article')
```

This hooks into events emitted by generated services (`article.created`, `article.updated`, `article.synced`, `article.deleted`). Call `bootSearch()` once during app bootstrap.

## search helper

The `search` helper provides a standalone API for working with indexes directly, without going through a model:

```typescript
import { search } from '@strav/search'
```

### Indexing documents

```typescript
await search.upsert('articles', 1, { title: 'Hello', body: '...' })

await search.upsertMany('articles', [
  { id: 1, title: 'First' },
  { id: 2, title: 'Second' },
])
```

### Removing documents

```typescript
await search.delete('articles', 1)
await search.deleteMany('articles', [1, 2, 3])
```

### Querying

```typescript
const results = await search.query('articles', 'typescript', {
  filter: { status: 'published' },
  page: 1,
  perPage: 20,
})
```

### Index management

```typescript
await search.createIndex('articles', {
  searchableAttributes: ['title', 'body'],
  filterableAttributes: ['status'],
})

await search.flush('articles')       // remove all documents, keep index
await search.deleteIndex('articles') // delete the entire index
```

## Index prefix

The `prefix` config option prepends a string to all index names. Useful for multi-environment setups:

```env
SEARCH_PREFIX=dev_
```

With this config, `Article.searchableAs()` returning `'articles'` resolves to the index `dev_articles`.

## Multiple engines

You can configure and use multiple engines simultaneously:

```typescript
// Use a named engine
const typesense = SearchManager.engine('typesense')
await typesense.search('articles', 'query')

// Or via the helper
search.engine('algolia').search('articles', 'query')
```

## Custom driver

Register a custom search driver with `extend()`:

```typescript
import { search } from '@strav/search'
import type { SearchEngine } from '@strav/search'

search.extend('sonic', (config) => {
  return new SonicDriver(config)
})
```

The factory receives the driver's config object from `config/search.ts`. The returned object must implement the `SearchEngine` interface.

Then set it as the driver in your config:

```typescript
// config/search.ts
export default {
  default: 'sonic',
  drivers: {
    sonic: {
      driver: 'sonic',
      host: env('SONIC_HOST', 'localhost'),
      port: env('SONIC_PORT', '1491').int(),
    },
  },
}
```

## CLI commands

The search package provides three CLI commands (auto-discovered by the framework):

### search:import

Import all records for a model into the search index:

```bash
bun strav search:import app/models/article.ts
bun strav search:import app/models/article.ts --chunk 1000
```

**Options:**
- `--chunk <size>` — Records per batch (default: `500`).

### search:flush

Remove all documents from a model's search index:

```bash
bun strav search:flush app/models/article.ts
```

### search:optimize

Merge FTS5 segments for a model's index (embedded driver only). FTS5 writes to small segments that are merged on the fly; running this periodically (e.g. nightly) compacts them into one for tighter storage and faster queries on large indexes:

```bash
bun strav search:optimize app/models/article.ts
```

For other drivers this command exits with an error — segment merging is the search engine's responsibility.

## Testing

Three options, depending on what you want to assert.

**1. Disable search entirely with `NullDriver`** — fastest, all writes are no-ops, all searches return empty:

```env
# .env.test
SEARCH_DRIVER=null
```

Or swap it in at runtime:

```typescript
import SearchManager, { NullDriver } from '@strav/search'

SearchManager.useEngine(new NullDriver())
```

**2. Real search against an in-memory index** — when you want to assert search behaviour without spinning up a Meilisearch container, point the embedded driver at `:memory:`:

```env
# .env.test
SEARCH_DRIVER=embedded
SEARCH_PATH=:memory:
```

Or programmatically:

```typescript
import SearchManager, { EmbeddedDriver } from '@strav/search'

SearchManager.useEngine(new EmbeddedDriver({ driver: 'embedded', path: ':memory:' }))
```

This gives you a fresh, real FTS5 index per test process — fast enough that `:memory:` is the default for the package's own tests.

**3. A recording engine** for asserting the calls without running them — useful for unit tests of code that orchestrates indexing:

```typescript
const engine = {
  name: 'recording',
  calls: [] as Array<{ method: string; args: unknown[] }>,
  async upsert(...args) { this.calls.push({ method: 'upsert', args }) },
  // ...implement the rest of SearchEngine identically
}
SearchManager.useEngine(engine)
```

Call `SearchManager.reset()` in test teardown to clear cached engines.

## Controller example

```typescript
import { search } from '@strav/search'

export default class ArticleController {
  async search(ctx: Context) {
    const { q, page = '1' } = ctx.query()

    const results = await Article.search(q, {
      page: parseInt(page, 10),
      perPage: 20,
      filter: { status: 'published' },
    })

    return ctx.json({
      articles: results.hits.map((h) => h.document),
      total: results.totalHits,
      page: results.page,
    })
  }

  async store(ctx: Context) {
    const data = await ctx.body<{ title: string; body: string }>()
    const article = await Article.create(data)

    // If bootSearch() is active, indexing happens automatically.
    // Otherwise, index manually:
    await article.searchIndex()

    return ctx.json(article, 201)
  }
}
```

## Drivers

### Embedded

In-process full-text search backed by `bun:sqlite`'s FTS5 engine. No external service to run — each index is a single `.sqlite` file under the configured `path`. Recommended for self-hosted apps, single-process deployments, and SMB-scale workloads (~50k documents per index).

**What you get:**

- BM25 ranking with per-field weights — column order in `searchableAttributes` controls relative weight (first = highest).
- Prefix queries (`type*`), exact phrases (`"quick brown fox"`), negation (`-foo`), required terms (`+foo`).
- Porter stemmer for English morphology (`running`, `runs`, `ran` all match `run`).
- Levenshtein-1 typo tolerance — `javasript` finds documents containing `javascript`. Configurable via `typoTolerance`.
- Highlighted snippets with `<mark>...</mark>` tags around matched terms; source text is HTML-escaped before being marked up.
- Object-form filters with `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `nin` operators against `filterableAttributes`.
- Sorting on any `sortableAttributes` column.
- Crash-safe persistence (SQLite WAL mode); concurrent reads, single writer per index file.

**Configuration knobs:**

- `path` — directory for `.sqlite` files (default `./storage/search`). Use `:memory:` for tests.
- `synchronous` — SQLite `PRAGMA synchronous`: `OFF` (fastest, can lose recent writes on power-loss), `NORMAL` (default — crash-safe with sub-second-of-writes loss), `FULL` (no loss, slowest).
- `typoTolerance`:
  - `'off'` — exact match only.
  - `'auto'` — Levenshtein-1 candidates for tokens of length ≥4 (default).
  - `{ minTokenLength: 5, maxDistance: 2 }` — fine-grained control. `maxDistance: 2` is much slower than 1 — only enable if needed.

**Per-field weights example.** Column order in `searchableAttributes` is the BM25 weight order (earlier columns weighted higher):

```typescript
class Ticket extends searchable(BaseModel) {
  static searchableSettings() {
    return {
      // subject is weighted higher than body for ranking purposes
      searchableAttributes: ['subject', 'body'],
      filterableAttributes: ['status', 'priority', 'tags'],
      sortableAttributes: ['priority', 'created_at'],
    }
  }
}
```

**Snippet output.** Snippets are escaped + tagged: `<mark>typescript</mark> handbook`. The driver replaces unsafe HTML in the source text first, so it's safe to render directly:

```typescript
const result = await Article.search('reliable', { attributesToHighlight: ['body'] })
// result.hits[0].highlights.body === 'Learn TypeScript fundamentals and write <mark>reliable</mark> code at scale.'
```

**Limitations (v1):**

- Stemming is English-only. Other languages are tokenised and matched but not morphologically reduced. Ranking quality on non-English content is reduced.
- One writer per index file (SQLite WAL). If you spawn multiple Bun workers all writing to the same index, writes serialize.
- Object-form filters only — raw SQL strings are rejected.
- Changing `searchableAttributes` after creation requires deleting and re-creating the index (`bun strav search:flush` then `bun strav search:import`), since the FTS5 schema is fixed at creation time.

**Why pick this driver:** you don't have to deploy or operate a separate search service. The trade-off vs. Meilisearch is mostly around very large datasets and very advanced ranking (synonyms, learned ranking, etc.) — for SMB-scale corpora, embedded is competitive.

### Meilisearch

Default port `7700`. Uses Bearer token authentication. Filter objects are converted to Meilisearch syntax (`key = value`, `key IN [values]`). Fast, easy to self-host, feature-rich. Pick this if you already run Meilisearch or you need synonyms/multi-language stemming out of the box.

### Typesense

Default port `8108`. Uses `X-TYPESENSE-API-KEY` header. Document IDs are always strings. Batch imports use JSONL format. Supports wildcard auto-detection fields.

### Algolia

Cloud-hosted. Uses `X-Algolia-Application-Id` and `X-Algolia-API-Key` headers. Indexes are created implicitly on first write. Pagination is 0-based internally (the API converts from 1-based). Settings map: `filterableAttributes` → `attributesForFaceting`.

### Null

No-op driver. All writes are discarded, searches return empty results. Useful for testing or disabling search in specific environments.
