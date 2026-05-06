import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test'
import { join } from 'node:path'
import { app, Configuration } from '@strav/kernel'
import { Database, BaseModel, primary } from '@strav/database'
import { Router } from '@strav/http'
import { TestCase } from '../src/test_case.ts'
import { Factory } from '../src/factory.ts'

// ---------------------------------------------------------------------------
// Test model
// ---------------------------------------------------------------------------

class Item extends BaseModel {
  @primary
  declare id: number
  declare name: string
}

// ---------------------------------------------------------------------------
// Factory tests (no DB required)
// ---------------------------------------------------------------------------

describe('Factory', () => {
  test('define creates a factory', () => {
    const f = Factory.define(Item, seq => ({ name: `Item ${seq}` }))
    expect(f).toBeInstanceOf(Factory)
  })

  test('make builds an in-memory instance', () => {
    const f = Factory.define(Item, seq => ({ name: `Item ${seq}` }))
    Factory.resetSequences()
    const item = f.make()
    expect(item.name).toBe('Item 1')
    expect(item._exists).toBe(false)
  })

  test('make applies overrides', () => {
    const f = Factory.define(Item, seq => ({ name: `Item ${seq}` }))
    const item = f.make({ name: 'Custom' })
    expect(item.name).toBe('Custom')
  })

  test('sequences increment', () => {
    const f = Factory.define(Item, seq => ({ name: `Item ${seq}` }))
    Factory.resetSequences()
    const a = f.make()
    const b = f.make()
    expect(a.name).toBe('Item 1')
    expect(b.name).toBe('Item 2')
  })

  test('resetSequences resets all counters', () => {
    const f = Factory.define(Item, seq => ({ name: `Item ${seq}` }))
    f.make()
    f.make()
    Factory.resetSequences()
    const item = f.make()
    expect(item.name).toBe('Item 1')
  })
})

// ---------------------------------------------------------------------------
// TestCase + Factory integration (requires DB)
// ---------------------------------------------------------------------------

describe('TestCase', () => {
  let db: Database
  let config: Configuration

  beforeAll(async () => {
    // Manual bootstrap for test infrastructure
    if (!app.has(Configuration))
      app.singleton(Configuration, () => new Configuration(join(import.meta.dir, '../config')))
    if (!app.has(Database)) app.singleton(Database)
    if (!app.has(Router)) app.singleton(Router)

    config = app.resolve(Configuration)
    await config.load()
    db = app.resolve(Database)
    await db.init()
    new BaseModel(db)

    await db.sql.unsafe('DROP TABLE IF EXISTS "item"')
    await db.sql.unsafe(`
      CREATE TABLE "item" (
        "id" SERIAL PRIMARY KEY,
        "name" VARCHAR(255) NOT NULL DEFAULT ''
      )
    `)
  })

  afterAll(async () => {
    await db.sql.unsafe('DROP TABLE IF EXISTS "item"')
    await db.close()
  })

  describe('setup and teardown', () => {
    test('setup boots the app and exposes db, router, config', async () => {
      // Already booted above, but test the TestCase constructor + fields
      const tc = new TestCase({ transaction: false })
      await tc.setup()

      expect(tc.db).toBeInstanceOf(Database)
      expect(tc.router).toBeInstanceOf(Router)
      expect(tc.config).toBeDefined()

      // Don't teardown — we share the DB connection with the outer suite
    })
  })

  describe('HTTP helpers', () => {
    let tc: TestCase

    beforeAll(async () => {
      tc = new TestCase({ transaction: false })
      await tc.setup()

      // Register inline routes for testing
      tc.router.get('/test/hello', ctx => ctx.json({ message: 'hello' }))
      tc.router.post('/test/echo', async ctx => {
        const body = await ctx.body()
        return ctx.json(body)
      })
      tc.router.put('/test/put', async ctx => {
        const body = await ctx.body()
        return ctx.json({ method: 'PUT', ...(body as object) })
      })
      tc.router.patch('/test/patch', async ctx => {
        const body = await ctx.body()
        return ctx.json({ method: 'PATCH', ...(body as object) })
      })
      tc.router.delete('/test/delete', ctx => ctx.json({ deleted: true }))
      tc.router.get('/test/headers', ctx => {
        return ctx.json({ auth: ctx.headers.get('authorization') ?? null })
      })
    })

    test('get()', async () => {
      const res = await tc.get('/test/hello')
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ message: 'hello' })
    })

    test('post() with JSON body', async () => {
      const res = await tc.post('/test/echo', { foo: 'bar' })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ foo: 'bar' })
    })

    test('put()', async () => {
      const res = await tc.put('/test/put', { x: 1 })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ method: 'PUT', x: 1 })
    })

    test('patch()', async () => {
      const res = await tc.patch('/test/patch', { x: 2 })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ method: 'PATCH', x: 2 })
    })

    test('delete()', async () => {
      const res = await tc.delete('/test/delete')
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ deleted: true })
    })

    test('returns 404 for unknown routes', async () => {
      const res = await tc.get('/test/nonexistent')
      expect(res.status).toBe(404)
    })

    test('withHeaders() injects custom headers', async () => {
      tc.withHeaders({ Authorization: 'Bearer test-123' })
      const res = await tc.get('/test/headers')
      const body = (await res.json()) as any
      expect(body.auth).toBe('Bearer test-123')

      // Clear for subsequent tests
      tc.withoutAuth()
      ;(tc as any)._headers = {}
    })
  })

  describe('Factory.create with DB', () => {
    const ItemFactory = Factory.define(Item, seq => ({
      name: `Widget ${seq}`,
    }))

    beforeEach(async () => {
      await db.sql.unsafe('DELETE FROM "item"')
    })

    test('create persists to database', async () => {
      Factory.resetSequences()
      const item = await ItemFactory.create()
      expect(item.id).toBeGreaterThan(0)
      expect(item.name).toBe('Widget 1')
      expect(item._exists).toBe(true)

      // Verify it's in DB
      const rows = await db.sql.unsafe('SELECT * FROM "item" WHERE "id" = $1', [item.id])
      expect(rows.length).toBe(1)
    })

    test('create applies overrides', async () => {
      const item = await ItemFactory.create({ name: 'Custom' })
      expect(item.name).toBe('Custom')
    })

    test('createMany persists multiple records', async () => {
      const items = await ItemFactory.createMany(3)
      expect(items).toHaveLength(3)
      for (const item of items) {
        expect(item.id).toBeGreaterThan(0)
        expect(item._exists).toBe(true)
      }

      const rows = await db.sql.unsafe('SELECT COUNT(*)::int AS count FROM "item"')
      expect((rows[0] as any).count).toBe(3)
    })
  })

  describe('transaction wrapping', () => {
    // This group manually manages beforeEach/afterEach to test transaction rollback

    let tc: TestCase

    beforeAll(async () => {
      // Ensure clean state
      await db.sql.unsafe('DELETE FROM "item"')

      tc = new TestCase({ transaction: true })
      // Don't call setup — we'll reuse the existing db/router
      tc.db = db
      tc.router = app.resolve(Router)
      tc.config = config
    })

    test('changes within a transaction are visible during the test', async () => {
      await tc.beforeEach()

      // Insert a row within the transaction
      await Item.create({ name: 'Transient' })
      const items = await Item.all()
      expect(items.length).toBe(1)
      expect(items[0].name).toBe('Transient')

      await tc.afterEach()
    })

    test('changes are rolled back after the previous test', async () => {
      await tc.beforeEach()

      // The row from the previous test should NOT exist
      const items = await Item.all()
      expect(items.length).toBe(0)

      await tc.afterEach()
    })

    test('multiple inserts within a test all rollback', async () => {
      await tc.beforeEach()

      await Item.create({ name: 'A' })
      await Item.create({ name: 'B' })
      await Item.create({ name: 'C' })
      const items = await Item.all()
      expect(items.length).toBe(3)

      await tc.afterEach()

      // Verify all rolled back — temporarily begin a new scope to check
      await tc.beforeEach()
      const after = await Item.all()
      expect(after.length).toBe(0)
      await tc.afterEach()
    })
  })
})
