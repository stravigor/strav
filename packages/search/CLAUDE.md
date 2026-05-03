# @strav/search

Full-text search with a unified API across multiple engines. Built-in drivers for Meilisearch, Typesense, Algolia, an in-process `embedded` driver backed by `bun:sqlite` FTS5 (no external service required), and a `postgres-fts` driver backed by tsvector + GIN + pg_trgm for higher-volume use against an existing Postgres. The searchable() mixin integrates search directly into ORM models.

## Dependencies
- @strav/kernel (peer)
- @strav/database (peer)
- @strav/cli (peer)

## Commands
- bun test
- bun run build

## Architecture
- src/search_manager.ts — main manager class
- src/search_provider.ts — service provider registration
- src/search_engine.ts — engine abstraction
- src/searchable.ts — ORM mixin for model indexing
- src/drivers/ — engine implementations (Meilisearch, Typesense, Algolia, Null)
- src/drivers/embedded/ — in-process FTS5 driver (engine, query compiler, typo expander, snippet formatter)
- src/drivers/postgres/ — postgres-fts driver (tsvector + GIN, pg_trgm typo expander, ts_headline snippets, in-place + batched rebuild)
- src/commands/ — CLI commands (search:import, search:flush, search:optimize, search:rebuild)
- src/types.ts — type definitions
- src/errors.ts — package-specific errors

## Conventions
- Drivers implement the search engine interface in search_engine.ts
- Use searchable() mixin on ORM models — don't call drivers directly
- Index operations go through CLI commands for bulk operations

## Multi-tenant scoping

`SearchManager.indexName(name, scope?)` accepts an optional `{ tenantId }` scope and rewrites the resolved index to `${prefix}t${tenantId}_${name}`. The driver layer is unchanged — namespacing happens at the manager boundary so two tenants on the same shared engine read independent indexes.

The convenience wrapper `search.for({ tenantId }).upsert(...)` / `.query(...)` / etc. applies the scope automatically. `tenantId` must match `/^[a-zA-Z0-9_-]+$/`; anything that could escape the namespace (slashes, spaces, SQL meta-chars) throws a `ConfigurationError`.

```ts
await search.for({ tenantId: 42 }).upsert('articles', 1, { … })
await search.for({ tenantId: 42 }).query('articles', 'lookup')
```
