import SearchManager from './search_manager.ts'
import type { SearchEngine } from './search_engine.ts'
import type {
  SearchDocument,
  SearchOptions,
  SearchResult,
  IndexSettings,
  DriverConfig,
  SearchScope,
} from './types.ts'

/**
 * Search helper — the primary convenience API.
 *
 * @example
 * import { search } from '@strav/search'
 *
 * const results = await search.query('articles', 'typescript generics')
 * await search.upsert('articles', 1, { title: 'Guide', body: '...' })
 */
export const search = {
  /** Get the underlying engine instance (default or named). */
  engine(name?: string): SearchEngine {
    return SearchManager.engine(name)
  },

  /** Register a custom search driver factory. */
  extend(name: string, factory: (config: DriverConfig) => SearchEngine): void {
    SearchManager.extend(name, factory)
  },

  /** Perform a full-text search query. */
  query(index: string, query: string, options?: SearchOptions): Promise<SearchResult> {
    return SearchManager.engine().search(SearchManager.indexName(index), query, options)
  },

  /** Add or update a single document. */
  upsert(index: string, id: string | number, document: Record<string, unknown>): Promise<void> {
    return SearchManager.engine().upsert(SearchManager.indexName(index), id, document)
  },

  /** Add or update multiple documents. */
  upsertMany(index: string, documents: SearchDocument[]): Promise<void> {
    return SearchManager.engine().upsertMany(SearchManager.indexName(index), documents)
  },

  /** Remove a document from the index. */
  delete(index: string, id: string | number): Promise<void> {
    return SearchManager.engine().delete(SearchManager.indexName(index), id)
  },

  /** Remove multiple documents from the index. */
  deleteMany(index: string, ids: Array<string | number>): Promise<void> {
    return SearchManager.engine().deleteMany(SearchManager.indexName(index), ids)
  },

  /** Remove all documents from an index. */
  flush(index: string): Promise<void> {
    return SearchManager.engine().flush(SearchManager.indexName(index))
  },

  /** Create an index with optional settings. */
  createIndex(index: string, options?: IndexSettings): Promise<void> {
    return SearchManager.engine().createIndex(SearchManager.indexName(index), options)
  },

  /** Delete an entire index. */
  deleteIndex(index: string): Promise<void> {
    return SearchManager.engine().deleteIndex(SearchManager.indexName(index))
  },

  /**
   * Return a tenant-scoped wrapper of this helper. All index names
   * resolved through it are namespaced as `${prefix}t${tenantId}_${name}`,
   * giving two tenants on the same shared engine independent indexes.
   *
   * @example
   * await search.for({ tenantId: 42 }).upsert('articles', 1, { … })
   * await search.for({ tenantId: 42 }).query('articles', 'lookup')
   *
   * Apps that don't need multi-tenant isolation skip `.for()` and call
   * the top-level helpers directly.
   */
  for(scope: SearchScope): ScopedSearch {
    return makeScoped(scope)
  },
}

// ── Scoped helper ────────────────────────────────────────────────────────

export interface ScopedSearch {
  query(index: string, query: string, options?: SearchOptions): Promise<SearchResult>
  upsert(index: string, id: string | number, document: Record<string, unknown>): Promise<void>
  upsertMany(index: string, documents: SearchDocument[]): Promise<void>
  delete(index: string, id: string | number): Promise<void>
  deleteMany(index: string, ids: Array<string | number>): Promise<void>
  flush(index: string): Promise<void>
  createIndex(index: string, options?: IndexSettings): Promise<void>
  deleteIndex(index: string): Promise<void>
}

function makeScoped(scope: SearchScope): ScopedSearch {
  return {
    query: (index, query, options) =>
      SearchManager.engine().search(SearchManager.indexName(index, scope), query, options),
    upsert: (index, id, document) =>
      SearchManager.engine().upsert(SearchManager.indexName(index, scope), id, document),
    upsertMany: (index, documents) =>
      SearchManager.engine().upsertMany(SearchManager.indexName(index, scope), documents),
    delete: (index, id) =>
      SearchManager.engine().delete(SearchManager.indexName(index, scope), id),
    deleteMany: (index, ids) =>
      SearchManager.engine().deleteMany(SearchManager.indexName(index, scope), ids),
    flush: index => SearchManager.engine().flush(SearchManager.indexName(index, scope)),
    createIndex: (index, options) =>
      SearchManager.engine().createIndex(SearchManager.indexName(index, scope), options),
    deleteIndex: index =>
      SearchManager.engine().deleteIndex(SearchManager.indexName(index, scope)),
  }
}
