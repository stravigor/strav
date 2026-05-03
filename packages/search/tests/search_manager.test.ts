import { describe, test, expect, beforeEach } from 'bun:test'
import SearchManager from '../src/search_manager.ts'
import { NullDriver } from '../src/drivers/null_driver.ts'
import { MeilisearchDriver } from '../src/drivers/meilisearch_driver.ts'
import { TypesenseDriver } from '../src/drivers/typesense_driver.ts'
import { AlgoliaDriver } from '../src/drivers/algolia_driver.ts'
import { bootSearch, recordingEngine } from './helpers.ts'

describe('SearchManager', () => {
  beforeEach(() => {
    SearchManager.reset()
  })

  test('reads config and exposes it', () => {
    bootSearch()
    expect(SearchManager.config.default).toBe('meilisearch')
    expect(SearchManager.config.prefix).toBe('')
  })

  test('creates meilisearch engine from config', () => {
    bootSearch()
    const engine = SearchManager.engine('meilisearch')
    expect(engine).toBeInstanceOf(MeilisearchDriver)
    expect(engine.name).toBe('meilisearch')
  })

  test('creates typesense engine from config', () => {
    bootSearch()
    const engine = SearchManager.engine('typesense')
    expect(engine).toBeInstanceOf(TypesenseDriver)
    expect(engine.name).toBe('typesense')
  })

  test('creates algolia engine from config', () => {
    bootSearch()
    const engine = SearchManager.engine('algolia')
    expect(engine).toBeInstanceOf(AlgoliaDriver)
    expect(engine.name).toBe('algolia')
  })

  test('creates null engine from config', () => {
    bootSearch({ default: 'null' })
    const engine = SearchManager.engine('null')
    expect(engine).toBeInstanceOf(NullDriver)
  })

  test('returns default engine when no name given', () => {
    bootSearch()
    const engine = SearchManager.engine()
    expect(engine).toBeInstanceOf(MeilisearchDriver)
  })

  test('caches engine instances', () => {
    bootSearch()
    const a = SearchManager.engine('meilisearch')
    const b = SearchManager.engine('meilisearch')
    expect(a).toBe(b)
  })

  test('throws on unknown driver', () => {
    bootSearch()
    expect(() => SearchManager.engine('redis')).toThrow('not configured')
  })

  test('throws when not configured', () => {
    expect(() => SearchManager.config).toThrow('not configured')
  })

  test('applies index prefix', () => {
    bootSearch({ prefix: 'myapp_' })
    expect(SearchManager.indexName('articles')).toBe('myapp_articles')
  })

  test('no prefix by default', () => {
    bootSearch()
    expect(SearchManager.indexName('articles')).toBe('articles')
  })

  // ── Multi-tenant scope (SR-1) ──────────────────────────────────────

  test('indexName applies tenant scope when provided', () => {
    bootSearch()
    expect(SearchManager.indexName('articles', { tenantId: 42 })).toBe('t42_articles')
    expect(SearchManager.indexName('articles', { tenantId: 'acme' })).toBe('tacme_articles')
  })

  test('indexName combines prefix + tenant scope', () => {
    bootSearch({ prefix: 'app_' })
    expect(SearchManager.indexName('articles', { tenantId: 42 })).toBe('app_t42_articles')
  })

  test('indexName ignores undefined / null scope', () => {
    bootSearch({ prefix: 'app_' })
    expect(SearchManager.indexName('articles')).toBe('app_articles')
    expect(SearchManager.indexName('articles', null)).toBe('app_articles')
  })

  test('indexName rejects tenantId values that could escape the namespace', () => {
    bootSearch()
    expect(() => SearchManager.indexName('articles', { tenantId: '../etc' })).toThrow(/tenantId/)
    expect(() => SearchManager.indexName('articles', { tenantId: 'evil; DROP TABLE' })).toThrow(
      /tenantId/
    )
    expect(() => SearchManager.indexName('articles', { tenantId: 'with space' })).toThrow(
      /tenantId/
    )
  })

  test('indexName accepts safe tenantId shapes', () => {
    bootSearch()
    expect(SearchManager.indexName('a', { tenantId: 'abc-123' })).toBe('tabc-123_a')
    expect(SearchManager.indexName('a', { tenantId: 'A_B_42' })).toBe('tA_B_42_a')
  })

  test('extend registers custom driver', () => {
    bootSearch({
      drivers: {
        custom: { driver: 'custom' },
      },
      default: 'custom',
    })

    const { engine } = recordingEngine('custom')
    SearchManager.extend('custom', () => engine)

    const resolved = SearchManager.engine('custom')
    expect(resolved.name).toBe('custom')
  })

  test('useEngine replaces an engine at runtime', () => {
    bootSearch()
    const { engine } = recordingEngine('meilisearch')
    SearchManager.useEngine(engine)

    const resolved = SearchManager.engine('meilisearch')
    expect(resolved).toBe(engine)
  })

  test('reset clears all state', () => {
    bootSearch()
    SearchManager.engine('meilisearch') // cache it
    SearchManager.reset()
    expect(() => SearchManager.config).toThrow('not configured')
  })
})
