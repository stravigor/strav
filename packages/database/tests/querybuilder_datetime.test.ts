import { expect, test, describe, beforeAll, afterAll } from 'bun:test'
import { DateTime } from 'luxon'
import { Container } from '@strav/kernel/core'
import Configuration from '@strav/kernel/config/configuration'
import Database from '../src/database/database'
import { BaseModel, cast, primary } from '../src/orm'
import { sql, query } from '../src/database'
import { ulid } from '@strav/kernel/helpers'

describe('QueryBuilder DateTime Handling', () => {
  let container: Container
  let db: Database

  beforeAll(async () => {
    // Setup DI container
    container = new Container()

    // Configure test database
    const config = new Configuration({})
    config.set('database.host', '127.0.0.1')
    config.set('database.port', 5432)
    config.set('database.username', 'liva')
    config.set('database.password', 'password1234')
    config.set('database.database', 'strav_testing')

    container.singleton(Configuration, () => config)
    container.singleton(Database)

    db = container.resolve(Database)
    await db.init()

    // Initialize BaseModel with database connection
    new BaseModel(db)

    // Create test table
    await sql`
      DROP TABLE IF EXISTS querybuilder_test_models
    `
    await sql`
      CREATE TABLE querybuilder_test_models (
        id VARCHAR(26) PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        published_at TIMESTAMPTZ NULL,
        scheduled_for TIMESTAMPTZ NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `
  })

  afterAll(async () => {
    // Clean up
    await sql`DROP TABLE IF EXISTS querybuilder_test_models`
    await db.close()
  })

  class QueryBuilderTestModel extends BaseModel {
    @primary
    declare id: string

    declare title: string
    declare publishedAt: DateTime | null

    @cast('json') // This would cause corruption before our fix
    declare scheduledFor: DateTime | null

    declare createdAt: DateTime
    declare updatedAt: DateTime

    static get tableName(): string {
      return 'querybuilder_test_models'
    }
  }

  test('should handle DateTime values in QueryBuilder where clauses', async () => {
    const testDateTime = DateTime.fromISO('2026-06-15T14:30:00.000Z')

    // Create a test record
    const model = new QueryBuilderTestModel()
    model.id = ulid()
    model.title = 'Test Article'
    model.publishedAt = testDateTime
    model.scheduledFor = testDateTime
    await model.save()

    // Query using QueryBuilder with DateTime values
    const found = await query(QueryBuilderTestModel)
      .where('publishedAt', testDateTime)
      .first()

    expect(found).not.toBeNull()
    expect(found!.id).toBe(model.id)
    expect(found!.publishedAt).toBeInstanceOf(DateTime)
    expect(found!.publishedAt!.toISO()).toBe(testDateTime.toISO())
  })

  test('should handle DateTime with @cast decorator in QueryBuilder', async () => {
    const testDateTime = DateTime.fromISO('2026-08-20T09:15:30.000Z')

    // Create a test record with @cast decorated DateTime field
    const model = new QueryBuilderTestModel()
    model.id = ulid()
    model.title = 'Scheduled Article'
    model.scheduledFor = testDateTime
    await model.save()

    // Query using the @cast decorated DateTime field
    const found = await query(QueryBuilderTestModel)
      .where('scheduledFor', testDateTime)
      .first()

    expect(found).not.toBeNull()
    expect(found!.scheduledFor).toBeInstanceOf(DateTime)
    expect(found!.scheduledFor!.toISO()).toBe(testDateTime.toISO())

    // Ensure not corrupted to 2000-01-01
    expect(found!.scheduledFor!.year).toBe(2026)
    expect(found!.scheduledFor!.month).toBe(8)
    expect(found!.scheduledFor!.day).toBe(20)
  })

  test('should handle DateTime range queries', async () => {
    const testDateTime = DateTime.fromISO('2026-06-15T12:00:00.000Z')

    // Create test record
    const model1 = new QueryBuilderTestModel()
    model1.id = ulid()
    model1.title = 'Article 1'
    model1.publishedAt = testDateTime
    await model1.save()

    // Query with DateTime comparison
    const found = await query(QueryBuilderTestModel)
      .where('publishedAt', '>', DateTime.fromISO('2026-01-01T00:00:00.000Z'))
      .where('id', model1.id)
      .all()

    expect(found.length).toBe(1)

    // Check that DateTime values are preserved correctly
    const record = found[0]
    expect(record.publishedAt).toBeInstanceOf(DateTime)
    expect(record.publishedAt!.year).toBe(2026)
    expect(record.publishedAt!.year).not.toBe(2000) // Not corrupted
  })

  test('should handle DateTime values in update operations', async () => {
    const originalDateTime = DateTime.fromISO('2026-03-10T08:00:00.000Z')
    const updatedDateTime = DateTime.fromISO('2026-03-15T10:30:00.000Z')

    // Create a test record
    const model = new QueryBuilderTestModel()
    model.id = ulid()
    model.title = 'Update Test'
    model.publishedAt = originalDateTime
    await model.save()

    // Update using QueryBuilder
    await query(QueryBuilderTestModel)
      .where('id', model.id)
      .update({ publishedAt: updatedDateTime })

    // Fetch updated record
    const updated = await QueryBuilderTestModel.find(model.id)
    expect(updated).not.toBeNull()
    expect(updated!.publishedAt).toBeInstanceOf(DateTime)
    expect(updated!.publishedAt!.toISO()).toBe(updatedDateTime.toISO())

    // Verify not corrupted
    expect(updated!.publishedAt!.year).toBe(2026)
    expect(updated!.publishedAt!.month).toBe(3)
    expect(updated!.publishedAt!.day).toBe(15)
  })

  test('should handle null DateTime values in queries', async () => {
    // Create a record with null DateTime
    const model = new QueryBuilderTestModel()
    model.id = ulid()
    model.title = 'Null DateTime Test'
    model.publishedAt = null
    await model.save()

    // Query for records with null DateTime
    const found = await query(QueryBuilderTestModel)
      .whereNull('publishedAt')
      .where('id', model.id)
      .first()

    expect(found).not.toBeNull()
    expect(found!.publishedAt).toBeNull()
  })

  test('should preserve DateTime precision through QueryBuilder operations', async () => {
    // Test with millisecond precision
    const preciseDateTime = DateTime.fromISO('2026-07-04T15:45:30.123Z')

    const model = new QueryBuilderTestModel()
    model.id = ulid()
    model.title = 'Precision Test'
    model.publishedAt = preciseDateTime
    await model.save()

    const found = await query(QueryBuilderTestModel)
      .where('id', model.id)
      .first()

    expect(found).not.toBeNull()
    expect(found!.publishedAt).toBeInstanceOf(DateTime)

    // Check millisecond precision is preserved (allow small DB rounding)
    const timeDiff = Math.abs(
      found!.publishedAt!.toMillis() - preciseDateTime.toMillis()
    )
    expect(timeDiff).toBeLessThan(1) // Less than 1ms difference

    // Verify year/month/day are exact
    expect(found!.publishedAt!.year).toBe(2026)
    expect(found!.publishedAt!.month).toBe(7)
    expect(found!.publishedAt!.day).toBe(4)
  })
})