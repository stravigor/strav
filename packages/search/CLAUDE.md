# @strav/search

Full-text search with a unified API across multiple engines. Built-in drivers for Meilisearch, Typesense, Algolia, and an in-process `embedded` driver backed by `bun:sqlite` FTS5 (no external service required). The searchable() mixin integrates search directly into ORM models.

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
- src/commands/ — CLI commands (search:import, search:flush, search:optimize)
- src/types.ts — type definitions
- src/errors.ts — package-specific errors

## Conventions
- Drivers implement the search engine interface in search_engine.ts
- Use searchable() mixin on ORM models — don't call drivers directly
- Index operations go through CLI commands for bulk operations
