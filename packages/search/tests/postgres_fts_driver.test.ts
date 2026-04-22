import { describe, test, expect, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test'
import { SQL } from 'bun'
import { PostgresFtsDriver } from '../src/drivers/postgres/index.ts'
import { UnsupportedFilterError } from '../src/drivers/postgres/errors.ts'

const PG_CONFIG = {
  hostname: process.env.DB_HOST ?? '127.0.0.1',
  port: Number(process.env.DB_PORT ?? 5432),
  username: process.env.DB_USER ?? 'liva',
  password: process.env.DB_PASSWORD ?? 'password1234',
  database: process.env.DB_DATABASE ?? 'strav_testing',
  max: 5,
}

let sql: SQL
const schemas: string[] = []

function uniqueSchema(): string {
  const name = `strav_search_test_${Math.random().toString(36).slice(2, 10)}`
  schemas.push(name)
  return name
}

async function dropSchema(name: string) {
  try {
    await sql.unsafe(`DROP SCHEMA IF EXISTS "${name}" CASCADE`)
  } catch {
    // ignore — best effort
  }
}

function newDriver(schema: string, overrides: Record<string, unknown> = {}) {
  return new PostgresFtsDriver({
    driver: 'postgres-fts',
    connection: sql,
    schema,
    language: 'english',
    typoTolerance: 'auto',
    workMem: null,
    gin: { fastupdate: false },
    ...overrides,
  })
}

const DEFAULT_SETTINGS = {
  searchableAttributes: ['title', 'body'],
  filterableAttributes: ['status', 'priority'],
  sortableAttributes: ['priority'],
}

beforeAll(() => {
  sql = new SQL(PG_CONFIG)
})

afterAll(async () => {
  for (const name of schemas) await dropSchema(name)
  await sql.close()
})

// ────────────────────────────────────────────────────────────────────────────
// Interface parity
// ────────────────────────────────────────────────────────────────────────────

describe('PostgresFtsDriver — basic interface parity', () => {
  let driver: PostgresFtsDriver
  let schema: string

  beforeEach(async () => {
    schema = uniqueSchema()
    driver = newDriver(schema)
    await driver.createIndex('articles', DEFAULT_SETTINGS)
  })
  afterEach(async () => dropSchema(schema))

  test('upsert + search returns the document', async () => {
    await driver.upsert('articles', 1, { title: 'Hello world', body: 'A first article.' })
    const result = await driver.search('articles', 'hello')
    expect(result.totalHits).toBe(1)
    expect(result.hits[0]!.document.title).toBe('Hello world')
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
    expect(String(result.hits[0]!.document.id)).toBe('3')
  })

  test('flush clears all documents but keeps the index', async () => {
    await driver.upsert('articles', 1, { title: 'A', body: 'a' })
    await driver.flush('articles')
    expect((await driver.search('articles', '')).totalHits).toBe(0)
    await driver.upsert('articles', 2, { title: 'B', body: 'b' })
    expect((await driver.search('articles', '')).totalHits).toBe(1)
  })

  test('upsert with same id updates the existing document', async () => {
    await driver.upsert('articles', 1, { title: 'Original', body: 'original body' })
    await driver.upsert('articles', 1, { title: 'Updated', body: 'updated body' })
    const result = await driver.search('articles', 'updated')
    expect(result.totalHits).toBe(1)
    expect(result.hits[0]!.document.title).toBe('Updated')
    const stale = await driver.search('articles', 'original')
    expect(stale.totalHits).toBe(0)
  })

  test('pagination cuts the right slice', async () => {
    // Zero-pad so lex-sort matches numeric order (typed columns are TEXT
    // in v1 — same behaviour the embedded driver documents).
    const docs = Array.from({ length: 25 }, (_, i) => ({
      id: i + 1,
      title: `Doc ${i + 1}`,
      body: 'common term',
      priority: String(i + 1).padStart(3, '0'),
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
    expect(String(page1.hits[0]!.document.id)).toBe('1')
    expect(page3.hits.length).toBe(5)
    expect(String(page3.hits[0]!.document.id)).toBe('21')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// FTS query semantics
// ────────────────────────────────────────────────────────────────────────────

describe('PostgresFtsDriver — FTS query semantics', () => {
  let driver: PostgresFtsDriver
  let schema: string

  beforeEach(async () => {
    schema = uniqueSchema()
    driver = newDriver(schema)
    await driver.createIndex('articles', DEFAULT_SETTINGS)
    await driver.upsertMany('articles', [
      { id: 1, title: 'TypeScript handbook', body: 'Learn TypeScript fundamentals.' },
      { id: 2, title: 'JavaScript handbook', body: 'Learn JavaScript fundamentals.' },
      { id: 3, title: 'Go language tour', body: 'A Go tour for newcomers.' },
      { id: 4, title: 'Quick brown fox', body: 'The quick brown fox jumps over the lazy dog.' },
    ])
  })
  afterEach(async () => dropSchema(schema))

  test('phrase query matches only adjacent terms', async () => {
    const result = await driver.search('articles', '"quick brown fox"')
    expect(result.totalHits).toBe(1)
    expect(String(result.hits[0]!.document.id)).toBe('4')
  })

  test('prefix query matches the stem', async () => {
    const result = await driver.search('articles', 'type*')
    expect(result.hits.some(h => String(h.document.id) === '1')).toBe(true)
  })

  test('negation excludes matching documents', async () => {
    const result = await driver.search('articles', 'handbook -javascript')
    expect(result.totalHits).toBe(1)
    expect(String(result.hits[0]!.document.id)).toBe('1')
  })

  test('Porter stemmer matches morphological variants', async () => {
    await driver.upsertMany('articles', [
      { id: 100, title: 'Runs the marathon', body: 'She runs every morning.' },
      { id: 101, title: 'Running shoes', body: 'Lightweight running shoes.' },
    ])
    const result = await driver.search('articles', 'run')
    const ids = result.hits.map(h => String(h.document.id))
    expect(ids).toContain('100')
    expect(ids).toContain('101')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Per-field weights
// ────────────────────────────────────────────────────────────────────────────

describe('PostgresFtsDriver — per-field weights and ranking', () => {
  let schema: string
  let driver: PostgresFtsDriver

  beforeEach(async () => {
    schema = uniqueSchema()
    driver = newDriver(schema)
  })
  afterEach(async () => dropSchema(schema))

  test('title-match outranks body-match when title is weight A', async () => {
    await driver.createIndex('weighted', {
      searchableAttributes: ['title', 'body'],
    })
    await driver.upsertMany('weighted', [
      { id: 'body', title: 'Other words here', body: 'Some text containing kubernetes deeply nested.' },
      { id: 'title', title: 'Kubernetes basics', body: 'Other body text.' },
    ])

    const result = await driver.search('weighted', 'kubernetes')
    expect(result.totalHits).toBe(2)
    expect(String(result.hits[0]!.document.id)).toBe('title')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Typo tolerance via pg_trgm
// ────────────────────────────────────────────────────────────────────────────

describe('PostgresFtsDriver — typo tolerance', () => {
  let driver: PostgresFtsDriver
  let schema: string

  beforeEach(async () => {
    schema = uniqueSchema()
    driver = newDriver(schema, { typoTolerance: 'auto' })
    await driver.createIndex('articles', DEFAULT_SETTINGS)
    await driver.upsertMany('articles', [
      { id: 1, title: 'JavaScript guide', body: 'A guide to javascript fundamentals.' },
      { id: 2, title: 'TypeScript guide', body: 'A guide to typescript.' },
      { id: 3, title: 'Cooking recipes', body: 'Tasty pasta recipes.' },
    ])
  })
  afterEach(async () => dropSchema(schema))

  test('Levenshtein-1 typo still matches', async () => {
    // 'javasript' is one deletion away from 'javascript'
    const result = await driver.search('articles', 'javasript')
    expect(result.totalHits).toBeGreaterThanOrEqual(1)
    expect(result.hits.some(h => String(h.document.id) === '1')).toBe(true)
  })

  test('typoTolerance: off disables expansion', async () => {
    const strictSchema = uniqueSchema()
    const strict = newDriver(strictSchema, { typoTolerance: 'off' })
    await strict.createIndex('articles', DEFAULT_SETTINGS)
    await strict.upsertMany('articles', [
      { id: 1, title: 'JavaScript guide', body: 'A guide to javascript fundamentals.' },
    ])
    const result = await strict.search('articles', 'javasript')
    expect(result.totalHits).toBe(0)
    await dropSchema(strictSchema)
  })

  test('exact term still matches when typo tolerance is on', async () => {
    const result = await driver.search('articles', 'pasta')
    expect(result.totalHits).toBe(1)
    expect(String(result.hits[0]!.document.id)).toBe('3')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Snippets
// ────────────────────────────────────────────────────────────────────────────

describe('PostgresFtsDriver — snippets', () => {
  let driver: PostgresFtsDriver
  let schema: string

  beforeEach(async () => {
    schema = uniqueSchema()
    driver = newDriver(schema)
    await driver.createIndex('articles', DEFAULT_SETTINGS)
    await driver.upsert('articles', 1, {
      title: 'TypeScript handbook',
      body: 'Learn TypeScript fundamentals and write reliable code at scale.',
    })
  })
  afterEach(async () => dropSchema(schema))

  test('returns highlighted body when requested', async () => {
    const result = await driver.search('articles', 'reliable', {
      attributesToHighlight: ['body'],
    })
    expect(result.hits[0]!.highlights?.body).toBeDefined()
    expect(result.hits[0]!.highlights?.body).toContain('<mark>')
    expect(result.hits[0]!.highlights?.body?.toLowerCase()).toContain('reliable')
  })

  test('escapes raw < > & " characters in snippet output', async () => {
    // Postgres' default text-search parser strips HTML-like tags during
    // tokenization, so a literal `<script>` never reaches the snippet.
    // What we still must escape are bare angle brackets, ampersands, and
    // quotes that survive tokenization — they could otherwise inject markup
    // when rendered.
    await driver.upsert('articles', 2, {
      title: 'Threshold check',
      body: 'A reliable threshold of a < b && c > d makes the alarm fire.',
    })
    const result = await driver.search('articles', 'reliable', {
      attributesToHighlight: ['body'],
    })
    const hit = result.hits.find(h => String(h.document.id) === '2')
    expect(hit?.highlights?.body).toContain('<mark>reliable</mark>')
    // No raw `<`/`>`/`&` outside our `<mark>` tags.
    const stripped = hit?.highlights?.body
      ?.replaceAll('<mark>', '')
      .replaceAll('</mark>', '') ?? ''
    expect(stripped).not.toMatch(/[<>]/)
    expect(stripped).not.toMatch(/&(?!(amp|lt|gt|quot|#39);)/)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Filters and sort
// ────────────────────────────────────────────────────────────────────────────

describe('PostgresFtsDriver — filters', () => {
  let driver: PostgresFtsDriver
  let schema: string

  beforeEach(async () => {
    schema = uniqueSchema()
    driver = newDriver(schema)
    await driver.createIndex('articles', DEFAULT_SETTINGS)
    await driver.upsertMany('articles', [
      { id: 1, title: 'Draft post', body: 'about ml', status: 'draft', priority: '1' },
      { id: 2, title: 'Published post', body: 'about ml', status: 'published', priority: '5' },
      { id: 3, title: 'Archived post', body: 'about ml', status: 'archived', priority: '3' },
    ])
  })
  afterEach(async () => dropSchema(schema))

  test('object filter narrows results by equality', async () => {
    const result = await driver.search('articles', 'ml', { filter: { status: 'published' } })
    expect(result.totalHits).toBe(1)
    expect(String(result.hits[0]!.document.id)).toBe('2')
  })

  test('array filter is treated as IN', async () => {
    const result = await driver.search('articles', 'ml', {
      filter: { status: ['draft', 'archived'] },
    })
    expect(result.totalHits).toBe(2)
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

describe('PostgresFtsDriver — sort and projection', () => {
  let driver: PostgresFtsDriver
  let schema: string

  beforeEach(async () => {
    schema = uniqueSchema()
    driver = newDriver(schema)
    await driver.createIndex('articles', DEFAULT_SETTINGS)
    await driver.upsertMany('articles', [
      { id: 1, title: 'A', body: 'apple', priority: '3' },
      { id: 2, title: 'B', body: 'apple', priority: '1' },
      { id: 3, title: 'C', body: 'apple', priority: '2' },
    ])
  })
  afterEach(async () => dropSchema(schema))

  test('sort by sortable column ascending', async () => {
    const result = await driver.search('articles', 'apple', { sort: ['priority:asc'] })
    expect(result.hits.map(h => String(h.document.id))).toEqual(['2', '3', '1'])
  })

  test('attributesToRetrieve projects only requested fields', async () => {
    const result = await driver.search('articles', 'apple', {
      attributesToRetrieve: ['id', 'title'],
    })
    expect(result.hits[0]!.document).toEqual({ id: 1, title: 'A' })
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Default text column
// ────────────────────────────────────────────────────────────────────────────

describe('PostgresFtsDriver — default text column (no settings)', () => {
  let driver: PostgresFtsDriver
  let schema: string

  beforeEach(() => {
    schema = uniqueSchema()
    driver = newDriver(schema)
  })
  afterEach(async () => dropSchema(schema))

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

// ────────────────────────────────────────────────────────────────────────────
// Multi-language
// ────────────────────────────────────────────────────────────────────────────

describe('PostgresFtsDriver — multi-language', () => {
  let driver: PostgresFtsDriver
  let schema: string

  beforeEach(() => {
    schema = uniqueSchema()
    driver = newDriver(schema, { language: 'french' })
  })
  afterEach(async () => dropSchema(schema))

  test('French stemmer matches morphological variants', async () => {
    await driver.createIndex('articles_fr', {
      searchableAttributes: ['title', 'body'],
      language: 'french',
    } as any)
    await driver.upsertMany('articles_fr', [
      { id: 1, title: 'Cours de cuisine', body: 'Comment bien préparer le pain.' },
      { id: 2, title: 'Préparations', body: 'Préparer un repas en avance.' },
    ])
    // 'préparer' / 'préparations' / 'préparé' all share the French stem 'prépar'
    const result = await driver.search('articles_fr', 'préparation')
    expect(result.totalHits).toBeGreaterThanOrEqual(1)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Bulk import perf (lightweight smoke for transactional batching)
// ────────────────────────────────────────────────────────────────────────────

describe('PostgresFtsDriver — bulk import smoke', () => {
  let driver: PostgresFtsDriver
  let schema: string

  beforeEach(async () => {
    schema = uniqueSchema()
    driver = newDriver(schema, { typoTolerance: 'off' })
    await driver.createIndex('bulk', { searchableAttributes: ['title', 'body'] })
  })
  afterEach(async () => dropSchema(schema))

  test('imports 2,000 docs in under 10 seconds', async () => {
    const docs = Array.from({ length: 2_000 }, (_, i) => ({
      id: i + 1,
      title: `Doc ${i + 1}`,
      body: `body content ${i + 1} with the words alpha beta gamma delta`,
    }))
    const start = performance.now()
    await driver.upsertMany('bulk', docs)
    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(10_000)

    const result = await driver.search('bulk', 'alpha', { perPage: 10 })
    expect(result.totalHits).toBe(2_000)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Index lifecycle
// ────────────────────────────────────────────────────────────────────────────

describe('PostgresFtsDriver — rebuild', () => {
  let schema: string
  beforeEach(() => {
    schema = uniqueSchema()
  })
  afterEach(async () => dropSchema(schema))

  test('rebuild picks tier 1 for small indexes and recomputes fts', async () => {
    const driver = newDriver(schema, { typoTolerance: 'off' })
    await driver.createIndex('articles', { searchableAttributes: ['title', 'body'] })
    await driver.upsertMany('articles', [
      { id: 1, title: 'Alpha', body: 'first' },
      { id: 2, title: 'Beta', body: 'second' },
    ])
    const result = await driver.rebuild('articles')
    expect(result.tier).toBe(1)
    expect(result.rows).toBe(2)
    // Existing rows still searchable after rebuild.
    expect((await driver.search('articles', 'alpha')).totalHits).toBe(1)
  })
})

describe('PostgresFtsDriver — deleteIndex', () => {
  let schema: string
  beforeEach(() => {
    schema = uniqueSchema()
  })
  afterEach(async () => dropSchema(schema))

  test('deleteIndex drops the table and removes meta', async () => {
    const driver = newDriver(schema)
    await driver.createIndex('temp', { searchableAttributes: ['title'] })
    await driver.upsert('temp', 1, { title: 'gone' })
    await driver.deleteIndex('temp')

    const rows = (await sql.unsafe(
      `SELECT 1 AS present FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace ` +
        `WHERE n.nspname = $1 AND c.relname = 'search_temp' LIMIT 1`,
      [schema]
    )) as Array<Record<string, unknown>>
    expect(rows.length).toBe(0)
  })
})
