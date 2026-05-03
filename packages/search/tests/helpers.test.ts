import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import SearchManager from '../src/search_manager.ts'
import { search } from '../src/helpers.ts'
import { bootSearch, recordingEngine } from './helpers.ts'
import type { EngineCall } from './helpers.ts'

describe('search helper', () => {
  let calls: EngineCall[]

  beforeEach(() => {
    bootSearch()
    const eng = recordingEngine('meilisearch')
    calls = eng.calls
    SearchManager.useEngine(eng.engine)
  })

  afterEach(() => {
    SearchManager.reset()
  })

  test('query delegates to engine.search', async () => {
    await search.query('articles', 'typescript', { page: 1 })
    expect(calls.length).toBe(1)
    expect(calls[0].method).toBe('search')
    expect(calls[0].args[0]).toBe('articles')
    expect(calls[0].args[1]).toBe('typescript')
  })

  test('upsert delegates to engine.upsert', async () => {
    await search.upsert('articles', 1, { title: 'Hi' })
    expect(calls[0].method).toBe('upsert')
    expect(calls[0].args).toEqual(['articles', 1, { title: 'Hi' }])
  })

  test('upsertMany delegates to engine.upsertMany', async () => {
    const docs = [
      { id: 1, title: 'A' },
      { id: 2, title: 'B' },
    ]
    await search.upsertMany('articles', docs)
    expect(calls[0].method).toBe('upsertMany')
    expect(calls[0].args[0]).toBe('articles')
  })

  test('delete delegates to engine.delete', async () => {
    await search.delete('articles', 1)
    expect(calls[0].method).toBe('delete')
    expect(calls[0].args).toEqual(['articles', 1])
  })

  test('deleteMany delegates to engine.deleteMany', async () => {
    await search.deleteMany('articles', [1, 2])
    expect(calls[0].method).toBe('deleteMany')
    expect(calls[0].args).toEqual(['articles', [1, 2]])
  })

  test('flush delegates to engine.flush', async () => {
    await search.flush('articles')
    expect(calls[0].method).toBe('flush')
    expect(calls[0].args).toEqual(['articles'])
  })

  test('createIndex delegates to engine.createIndex', async () => {
    await search.createIndex('articles', { searchableAttributes: ['title'] })
    expect(calls[0].method).toBe('createIndex')
    expect(calls[0].args[0]).toBe('articles')
  })

  test('deleteIndex delegates to engine.deleteIndex', async () => {
    await search.deleteIndex('articles')
    expect(calls[0].method).toBe('deleteIndex')
    expect(calls[0].args).toEqual(['articles'])
  })

  test('engine returns the underlying engine', () => {
    const engine = search.engine()
    expect(engine.name).toBe('meilisearch')
  })

  test('applies prefix to index names', async () => {
    SearchManager.reset()
    bootSearch({ prefix: 'prod_' })
    const eng = recordingEngine('meilisearch')
    SearchManager.useEngine(eng.engine)

    await search.query('articles', 'test')
    expect(eng.calls[0].args[0]).toBe('prod_articles')
  })

  // ── search.for(scope) — multi-tenant scoping (SR-1) ────────────────

  test('for(scope).upsert namespaces the index with t<tenantId>_', async () => {
    await search.for({ tenantId: 42 }).upsert('articles', 1, { title: 'Hi' })
    expect(calls[0].method).toBe('upsert')
    expect(calls[0].args[0]).toBe('t42_articles')
  })

  test('for(scope).query namespaces the index', async () => {
    await search.for({ tenantId: 'acme' }).query('articles', 'lookup')
    expect(calls[0].method).toBe('search')
    expect(calls[0].args[0]).toBe('tacme_articles')
  })

  test('for(scope) covers every method on the helper', async () => {
    const scoped = search.for({ tenantId: 7 })
    await scoped.upsert('a', 1, {})
    await scoped.upsertMany('a', [{ id: 1 }])
    await scoped.delete('a', 1)
    await scoped.deleteMany('a', [1])
    await scoped.flush('a')
    await scoped.createIndex('a')
    await scoped.deleteIndex('a')
    await scoped.query('a', 'q')

    // Every recorded call's index argument is namespaced.
    for (const call of calls) {
      expect(call.args[0]).toBe('t7_a')
    }
  })

  test('for(scope) combines with the configured prefix', async () => {
    SearchManager.reset()
    bootSearch({ prefix: 'app_' })
    const eng = recordingEngine('meilisearch')
    SearchManager.useEngine(eng.engine)

    await search.for({ tenantId: 'acme' }).query('articles', 'lookup')
    expect(eng.calls[0].args[0]).toBe('app_tacme_articles')
  })

  test('two tenants resolve to independent indexes', async () => {
    await search.for({ tenantId: 1 }).upsert('articles', 1, { title: 'A' })
    await search.for({ tenantId: 2 }).upsert('articles', 1, { title: 'B' })
    expect(calls[0].args[0]).toBe('t1_articles')
    expect(calls[1].args[0]).toBe('t2_articles')
    expect(calls[0].args[0]).not.toBe(calls[1].args[0])
  })
})
