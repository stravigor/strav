# Search

Full-text search with a unified API across multiple engines. Built-in drivers for **Meilisearch**, **Typesense**, and **Algolia**. Custom drivers can be added via `extend()`.

The `searchable()` mixin integrates search directly into your ORM models — upsert on save, remove on delete, query with a single static method.

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

The search package provides two CLI commands (auto-discovered by the framework):

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

## Testing

Use the `NullDriver` to disable search in tests:

```env
# .env.test
SEARCH_DRIVER=null
```

Or swap in a recording engine at runtime:

```typescript
import SearchManager from '@strav/search'
import { NullDriver } from '@strav/search'

SearchManager.useEngine(new NullDriver())
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

### Meilisearch

Default port `7700`. Uses Bearer token authentication. Filter objects are converted to Meilisearch syntax (`key = value`, `key IN [values]`). The recommended driver for most projects — fast, easy to self-host, and feature-rich.

### Typesense

Default port `8108`. Uses `X-TYPESENSE-API-KEY` header. Document IDs are always strings. Batch imports use JSONL format. Supports wildcard auto-detection fields.

### Algolia

Cloud-hosted. Uses `X-Algolia-Application-Id` and `X-Algolia-API-Key` headers. Indexes are created implicitly on first write. Pagination is 0-based internally (the API converts from 1-based). Settings map: `filterableAttributes` → `attributesForFaceting`.

### Null

No-op driver. All writes are discarded, searches return empty results. Useful for testing or disabling search in specific environments.
