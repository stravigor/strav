import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EmbeddedDriver } from '../src/drivers/embedded/index.ts'
import { UnsupportedFilterError } from '../src/drivers/embedded/errors.ts'

function newDriver(overrides: Record<string, unknown> = {}) {
  return new EmbeddedDriver({
    driver: 'embedded',
    path: ':memory:',
    synchronous: 'OFF',
    typoTolerance: 'auto',
    ...overrides,
  })
}

const DEFAULT_SETTINGS = {
  searchableAttributes: ['title', 'body'],
  filterableAttributes: ['status', 'tags', 'priority'],
  sortableAttributes: ['priority', 'created_at'],
}

describe('EmbeddedDriver — basic interface parity', () => {
  let driver: EmbeddedDriver

  beforeEach(async () => {
    driver = newDriver()
    await driver.createIndex('articles', DEFAULT_SETTINGS)
  })

  afterEach(() => driver.close())

  test('upsert + search returns the document', async () => {
    await driver.upsert('articles', 1, { title: 'Hello world', body: 'A first article.' })
    const result = await driver.search('articles', 'hello')
    expect(result.totalHits).toBe(1)
    expect(result.hits[0].document.id).toBe(1)
    expect(result.hits[0].document.title).toBe('Hello world')
  })

  test('upsertMany inserts every document', async () => {
    await driver.upsertMany('articles', [
      { id: 1, title: 'Alpha', body: 'first' },
      { id: 2, title: 'Beta', body: 'second' },
      { id: 3, title: 'Gamma', body: 'third' },
    ])
    const result = await driver.search('articles', '')
    expect(result.totalHits).toBe(3)
  })

  test('delete removes a document', async () => {
    await driver.upsert('articles', 1, { title: 'Delete me', body: 'gone' })
    await driver.delete('articles', 1)
    const result = await driver.search('articles', 'delete')
    expect(result.totalHits).toBe(0)
  })

  test('deleteMany removes multiple documents', async () => {
    await driver.upsertMany('articles', [
      { id: 1, title: 'A', body: 'a' },
      { id: 2, title: 'B', body: 'b' },
      { id: 3, title: 'C', body: 'c' },
    ])
    await driver.deleteMany('articles', [1, 2])
    const result = await driver.search('articles', '')
    expect(result.totalHits).toBe(1)
    expect(result.hits[0].document.id).toBe(3)
  })

  test('flush clears all documents but keeps the index', async () => {
    await driver.upsert('articles', 1, { title: 'A', body: 'a' })
    await driver.flush('articles')
    const result = await driver.search('articles', '')
    expect(result.totalHits).toBe(0)
    // Index still works for a new doc after flush
    await driver.upsert('articles', 2, { title: 'B', body: 'b' })
    expect((await driver.search('articles', '')).totalHits).toBe(1)
  })

  test('upsert with same id updates the existing document', async () => {
    await driver.upsert('articles', 1, { title: 'Original', body: 'original body' })
    await driver.upsert('articles', 1, { title: 'Updated', body: 'updated body' })
    const result = await driver.search('articles', 'updated')
    expect(result.totalHits).toBe(1)
    expect(result.hits[0].document.title).toBe('Updated')
    // Original term should be gone
    const stale = await driver.search('articles', 'original')
    expect(stale.totalHits).toBe(0)
  })

  test('pagination cuts the right slice', async () => {
    const docs = Array.from({ length: 25 }, (_, i) => ({
      id: i + 1,
      title: `Doc ${i + 1}`,
      body: 'common term',
      priority: i + 1,
    }))
    await driver.upsertMany('articles', docs)
    const page1 = await driver.search('articles', 'common', {
      perPage: 10,
      page: 1,
      sort: ['priority:asc'],
    })
    const page3 = await driver.search('articles', 'common', {
      perPage: 10,
      page: 3,
      sort: ['priority:asc'],
    })
    expect(page1.totalHits).toBe(25)
    expect(page1.hits.length).toBe(10)
    expect(page1.hits[0].document.id).toBe(1)
    expect(page3.hits.length).toBe(5)
    expect(page3.hits[0].document.id).toBe(21)
  })
})

describe('EmbeddedDriver — FTS query semantics', () => {
  let driver: EmbeddedDriver
  beforeEach(async () => {
    driver = newDriver()
    await driver.createIndex('articles', DEFAULT_SETTINGS)
    await driver.upsertMany('articles', [
      { id: 1, title: 'TypeScript handbook', body: 'Learn TypeScript fundamentals.' },
      { id: 2, title: 'JavaScript handbook', body: 'Learn JavaScript fundamentals.' },
      { id: 3, title: 'Go language tour', body: 'A Go tour for newcomers.' },
      { id: 4, title: 'Quick brown fox', body: 'The quick brown fox jumps over the lazy dog.' },
    ])
  })
  afterEach(() => driver.close())

  test('phrase query matches only adjacent terms', async () => {
    const result = await driver.search('articles', '"quick brown fox"')
    expect(result.totalHits).toBe(1)
    expect(result.hits[0].document.id).toBe(4)
  })

  test('prefix query matches the stem', async () => {
    const result = await driver.search('articles', 'type*')
    expect(result.hits.some(h => h.document.id === 1)).toBe(true)
  })

  test('negation excludes matching documents', async () => {
    const result = await driver.search('articles', 'handbook -javascript')
    expect(result.totalHits).toBe(1)
    expect(result.hits[0].document.id).toBe(1)
  })

  test('Porter stemmer matches morphological variants', async () => {
    await driver.upsertMany('articles', [
      { id: 100, title: 'Runs the marathon', body: 'She runs every morning.' },
      { id: 101, title: 'Running shoes', body: 'Lightweight running shoes.' },
    ])
    const result = await driver.search('articles', 'run')
    const ids = result.hits.map(h => h.document.id)
    expect(ids).toContain(100)
    expect(ids).toContain(101)
  })
})

describe('EmbeddedDriver — per-field weights and ranking', () => {
  let driver: EmbeddedDriver

  beforeEach(() => {
    driver = newDriver()
  })
  afterEach(() => driver.close())

  test('title-match outranks body-match when title weight is higher', async () => {
    await driver.createIndex('weighted', {
      searchableAttributes: ['title', 'body'],
    })
    await driver.upsertMany('weighted', [
      { id: 'body', title: 'Other words here', body: 'Some text containing kubernetes deeply nested.' },
      { id: 'title', title: 'Kubernetes basics', body: 'Other body text.' },
    ])

    const result = await driver.search('weighted', 'kubernetes')
    expect(result.totalHits).toBe(2)
    // Both rank, but title-hit ranks above body-hit because of FTS5 BM25 column boost.
    expect(result.hits[0].document.id).toBe('title')
  })
})

describe('EmbeddedDriver — typo tolerance', () => {
  let driver: EmbeddedDriver
  beforeEach(async () => {
    driver = newDriver({ typoTolerance: 'auto' })
    await driver.createIndex('articles', DEFAULT_SETTINGS)
    await driver.upsertMany('articles', [
      { id: 1, title: 'JavaScript guide', body: 'A guide to javascript fundamentals.' },
      { id: 2, title: 'TypeScript guide', body: 'A guide to typescript.' },
      { id: 3, title: 'Cooking recipes', body: 'Tasty pasta recipes.' },
    ])
  })
  afterEach(() => driver.close())

  test('Levenshtein-1 typo still matches', async () => {
    // 'javasript' is one deletion away from 'javascript'
    const result = await driver.search('articles', 'javasript')
    expect(result.totalHits).toBeGreaterThanOrEqual(1)
    expect(result.hits.some(h => h.document.id === 1)).toBe(true)
  })

  test('typoTolerance: off disables expansion', async () => {
    const strictDriver = newDriver({ typoTolerance: 'off' })
    await strictDriver.createIndex('articles', DEFAULT_SETTINGS)
    await strictDriver.upsertMany('articles', [
      { id: 1, title: 'JavaScript guide', body: 'A guide to javascript fundamentals.' },
    ])
    const result = await strictDriver.search('articles', 'javasript')
    expect(result.totalHits).toBe(0)
    strictDriver.close()
  })

  test('exact term still matches when typo tolerance is on', async () => {
    const result = await driver.search('articles', 'pasta')
    expect(result.totalHits).toBe(1)
    expect(result.hits[0].document.id).toBe(3)
  })

  test('terms dict updates on delete (typo expansion drops removed term)', async () => {
    await driver.delete('articles', 1)
    // After deletion, the only doc with 'javascript' is gone — typo lookup
    // should no longer pull in 'javascript' from the dictionary.
    const result = await driver.search('articles', 'javasript')
    expect(result.hits.find(h => h.document.id === 1)).toBeUndefined()
  })
})

describe('EmbeddedDriver — snippets', () => {
  let driver: EmbeddedDriver
  beforeEach(async () => {
    driver = newDriver()
    await driver.createIndex('articles', DEFAULT_SETTINGS)
    await driver.upsert('articles', 1, {
      title: 'TypeScript handbook',
      body: 'Learn TypeScript fundamentals and write reliable code at scale.',
    })
  })
  afterEach(() => driver.close())

  test('returns highlighted body when requested', async () => {
    const result = await driver.search('articles', 'reliable', {
      attributesToHighlight: ['body'],
    })
    expect(result.hits[0].highlights?.body).toBeDefined()
    expect(result.hits[0].highlights?.body).toContain('<mark>reliable</mark>')
  })

  test('escapes HTML in source text', async () => {
    await driver.upsert('articles', 2, {
      title: 'Dangerous <script>',
      body: '<script>alert("xss")</script> contains a phrase about reliable behaviour.',
    })
    const result = await driver.search('articles', 'reliable', {
      attributesToHighlight: ['body'],
    })
    const hit = result.hits.find(h => h.document.id === 2)
    expect(hit?.highlights?.body).not.toContain('<script>')
    expect(hit?.highlights?.body).toContain('&lt;script&gt;')
    expect(hit?.highlights?.body).toContain('<mark>reliable</mark>')
  })
})

describe('EmbeddedDriver — filters', () => {
  let driver: EmbeddedDriver
  beforeEach(async () => {
    driver = newDriver()
    await driver.createIndex('articles', DEFAULT_SETTINGS)
    await driver.upsertMany('articles', [
      { id: 1, title: 'Draft post', body: 'about ml', status: 'draft', priority: 1 },
      { id: 2, title: 'Published post', body: 'about ml', status: 'published', priority: 5 },
      { id: 3, title: 'Archived post', body: 'about ml', status: 'archived', priority: 3 },
    ])
  })
  afterEach(() => driver.close())

  test('object filter narrows results by equality', async () => {
    const result = await driver.search('articles', 'ml', {
      filter: { status: 'published' },
    })
    expect(result.totalHits).toBe(1)
    expect(result.hits[0].document.id).toBe(2)
  })

  test('array filter is treated as IN', async () => {
    const result = await driver.search('articles', 'ml', {
      filter: { status: ['draft', 'archived'] },
    })
    expect(result.totalHits).toBe(2)
  })

  test('operator object: gte/lt', async () => {
    const result = await driver.search('articles', 'ml', {
      filter: { priority: { gte: 3 } },
    })
    const ids = result.hits.map(h => h.document.id).sort()
    expect(ids).toEqual([2, 3])
  })

  test('rejects raw string filter', async () => {
    await expect(
      driver.search('articles', 'ml', { filter: "status = 'published'" })
    ).rejects.toThrow(UnsupportedFilterError)
  })

  test('rejects filter on non-filterable attribute', async () => {
    await expect(
      driver.search('articles', 'ml', { filter: { title: 'Draft post' } })
    ).rejects.toThrow(UnsupportedFilterError)
  })
})

describe('EmbeddedDriver — sort and projection', () => {
  let driver: EmbeddedDriver
  beforeEach(async () => {
    driver = newDriver()
    await driver.createIndex('articles', DEFAULT_SETTINGS)
    await driver.upsertMany('articles', [
      { id: 1, title: 'A', body: 'apple', priority: 3 },
      { id: 2, title: 'B', body: 'apple', priority: 1 },
      { id: 3, title: 'C', body: 'apple', priority: 2 },
    ])
  })
  afterEach(() => driver.close())

  test('sort by sortable column ascending', async () => {
    const result = await driver.search('articles', 'apple', { sort: ['priority:asc'] })
    expect(result.hits.map(h => h.document.id)).toEqual([2, 3, 1])
  })

  test('sort descending', async () => {
    const result = await driver.search('articles', 'apple', { sort: ['priority:desc'] })
    expect(result.hits.map(h => h.document.id)).toEqual([1, 3, 2])
  })

  test('rejects sort on non-sortable attribute', async () => {
    await expect(
      driver.search('articles', 'apple', { sort: ['title:asc'] })
    ).rejects.toThrow(/sortableAttributes/)
  })

  test('attributesToRetrieve projects only requested fields', async () => {
    const result = await driver.search('articles', 'apple', {
      attributesToRetrieve: ['id', 'title'],
    })
    expect(result.hits[0].document).toEqual({ id: 1, title: 'A' })
  })
})

describe('EmbeddedDriver — default text column (no settings)', () => {
  let driver: EmbeddedDriver
  beforeEach(() => {
    driver = newDriver()
  })
  afterEach(() => driver.close())

  test('upsert without createIndex auto-creates default schema', async () => {
    await driver.upsert('default_idx', 1, { title: 'Apple', body: 'A red apple.' })
    const result = await driver.search('default_idx', 'apple')
    expect(result.totalHits).toBe(1)
  })

  test('default schema concatenates all string fields for search', async () => {
    await driver.upsert('default_idx', 1, { name: 'Bob', city: 'Lyon' })
    const byName = await driver.search('default_idx', 'bob')
    const byCity = await driver.search('default_idx', 'lyon')
    expect(byName.totalHits).toBe(1)
    expect(byCity.totalHits).toBe(1)
  })
})

describe('EmbeddedDriver — bulk import perf', () => {
  let driver: EmbeddedDriver
  beforeEach(async () => {
    driver = newDriver()
    await driver.createIndex('bulk', { searchableAttributes: ['title', 'body'] })
  })
  afterEach(() => driver.close())

  test('imports 5,000 docs in under 1 second', async () => {
    const docs = Array.from({ length: 5_000 }, (_, i) => ({
      id: i + 1,
      title: `Doc ${i + 1}`,
      body: `body content ${i + 1} with the words alpha beta gamma delta`,
    }))
    const start = performance.now()
    await driver.upsertMany('bulk', docs)
    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(1_000)

    const result = await driver.search('bulk', 'alpha', { perPage: 10 })
    expect(result.totalHits).toBe(5_000)
  })
})

describe('EmbeddedDriver — file persistence and crash safety', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'strav-search-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('reopen finds previously written documents', async () => {
    const a = new EmbeddedDriver({
      driver: 'embedded',
      path: dir,
      synchronous: 'NORMAL',
      typoTolerance: 'auto',
    })
    await a.createIndex('articles', { searchableAttributes: ['title', 'body'] })
    await a.upsertMany('articles', [
      { id: 1, title: 'Persist me', body: 'survives a restart' },
      { id: 2, title: 'And me too', body: 'should also survive' },
    ])
    a.close()

    const b = new EmbeddedDriver({
      driver: 'embedded',
      path: dir,
      synchronous: 'NORMAL',
      typoTolerance: 'auto',
    })
    const result = await b.search('articles', 'survive')
    expect(result.totalHits).toBe(2)
    b.close()
  })

  test('deleteIndex removes the on-disk files', async () => {
    const driver = new EmbeddedDriver({
      driver: 'embedded',
      path: dir,
      synchronous: 'NORMAL',
      typoTolerance: 'off',
    })
    await driver.createIndex('temp', { searchableAttributes: ['title'] })
    await driver.upsert('temp', 1, { title: 'gone' })
    await driver.deleteIndex('temp')

    const fs = await import('node:fs/promises')
    await expect(fs.access(join(dir, 'temp.sqlite'))).rejects.toThrow()
    driver.close()
  })
})
