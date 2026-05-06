import { expect, test, describe, beforeAll, afterAll, spyOn } from 'bun:test'
import { DateTime } from 'luxon'
import { Container } from '@strav/kernel/core'
import Configuration from '@strav/kernel/config/configuration'
import Database from '../src/database/database'
import { BaseModel, cast, primary } from '../src/orm'
import { sql } from '../src/database'

describe('DateTime Corruption Prevention', () => {
  let container: Container
  let db: Database
  let consoleSpy: ReturnType<typeof spyOn>

  beforeAll(async () => {
    // Spy on console.warn to catch validation warnings BEFORE class definitions
    consoleSpy = spyOn(console, 'warn').mockImplementation(() => {})

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
      DROP TABLE IF EXISTS datetime_test_models
    `
    await sql`
      CREATE TABLE datetime_test_models (
        id SERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        deleted_at TIMESTAMPTZ NULL,
        json_casted_date TIMESTAMPTZ NULL,
        boolean_casted_date TIMESTAMPTZ NULL,
        normal_datetime TIMESTAMPTZ NULL,
        test_date TIMESTAMPTZ NULL,
        problematic_date TIMESTAMPTZ NULL,
        test_casted_date TIMESTAMPTZ NULL
      )
    `
  })

  afterAll(async () => {
    // Clean up
    await sql`DROP TABLE IF EXISTS datetime_test_models`
    await db.close()
    consoleSpy.mockRestore()
  })

  describe('DateTime Cast Priority', () => {
    class TestModel extends BaseModel {
      @primary
      declare id: number

      declare createdAt: DateTime
      declare updatedAt: DateTime
      declare deletedAt: DateTime | null

      @cast('json')
      declare jsonCastedDate: DateTime

      @cast('boolean')
      declare booleanCastedDate: DateTime

      declare normalDatetime: DateTime | null

      static get tableName(): string {
        return 'datetime_test_models'
      }
    }

    test('should warn when @cast is applied to DateTime fields', () => {
      // Clear previous calls and create a new model class to trigger warnings
      consoleSpy.mockClear()

      class NewTestModel extends BaseModel {
        @cast('json')
        declare testCastedDate: DateTime

        static get tableName(): string {
          return 'datetime_test_models'
        }
      }

      // The warning should have been triggered during class definition
      expect(consoleSpy).toHaveBeenCalledWith(
        expect.stringContaining('Warning: @cast applied to DateTime field "testCastedDate"')
      )
    })

    test('should preserve DateTime values during save/load cycle', async () => {
      const testDateTime = DateTime.fromISO('2026-04-03T05:00:49.978+00:00')

      // Create instance with DateTime value
      const model = new TestModel()
      model.normalDatetime = testDateTime

      // Save to database
      await model.save()
      expect(model._exists).toBe(true)

      // Load from database
      const loaded = await TestModel.find(model.id)
      expect(loaded).not.toBeNull()
      expect(loaded!.normalDatetime).toBeInstanceOf(DateTime)

      // Verify the DateTime value is preserved (not corrupted to 2000-01-01)
      expect(loaded!.normalDatetime!.toISO()).toBe('2026-04-03T05:00:49.978+00:00')
      expect(loaded!.normalDatetime!.year).toBe(2026)
      expect(loaded!.normalDatetime!.month).toBe(4)
      expect(loaded!.normalDatetime!.day).toBe(3)
    })

    test('should handle DateTime fields with @cast decorators correctly', async () => {
      const testDateTime = DateTime.fromISO('2026-04-03T05:00:49.978+00:00')

      const model = new TestModel()
      model.jsonCastedDate = testDateTime
      model.booleanCastedDate = testDateTime

      // Save should prioritize DateTime conversion over cast operations
      await model.save()

      // Load and verify values
      const loaded = await TestModel.find(model.id)
      expect(loaded).not.toBeNull()

      // These fields should still be DateTime objects, not corrupted
      expect(loaded!.jsonCastedDate).toBeInstanceOf(DateTime)
      expect(loaded!.booleanCastedDate).toBeInstanceOf(DateTime)

      // Verify the specific corruption case is prevented
      expect(loaded!.jsonCastedDate.toISO()).toBe('2026-04-03T05:00:49.978+00:00')
      expect(loaded!.booleanCastedDate.toISO()).toBe('2026-04-03T05:00:49.978+00:00')

      // Ensure not corrupted to 2000-01-01
      expect(loaded!.jsonCastedDate.year).not.toBe(2000)
      expect(loaded!.booleanCastedDate.year).not.toBe(2000)
    })

    test('should handle null DateTime values correctly', async () => {
      const model = new TestModel()
      model.normalDatetime = null

      await model.save()

      const loaded = await TestModel.find(model.id)
      expect(loaded).not.toBeNull()
      expect(loaded!.normalDatetime).toBeNull()
    })

    test('should handle updatedAt auto-assignment', async () => {
      const model = new TestModel()
      await model.save()

      const originalUpdatedAt = model.updatedAt

      // Wait a moment to ensure different timestamp
      await new Promise(resolve => setTimeout(resolve, 10))

      // Trigger an update
      model.normalDatetime = DateTime.now()
      await model.save()

      // updatedAt should have been updated and not corrupted
      expect(model.updatedAt).toBeInstanceOf(DateTime)
      expect(model.updatedAt.toMillis()).toBeGreaterThan(originalUpdatedAt.toMillis())
      expect(model.updatedAt.year).not.toBe(2000) // Not corrupted
    })
  })

  describe('DateTime Edge Cases', () => {
    class EdgeCaseModel extends BaseModel {
      @primary
      declare id: number

      declare testDate: DateTime | null

      static get tableName(): string {
        return 'datetime_test_models'
      }
    }

    test('should handle various DateTime formats', async () => {
      const testCases = [
        DateTime.fromISO('2026-04-03T05:00:49.978+00:00'),
        DateTime.fromISO('1990-01-01T00:00:00.000Z'),
        DateTime.fromISO('2050-12-31T23:59:59.999-05:00'),
        DateTime.now(),
      ]

      for (const testDateTime of testCases) {
        const model = new EdgeCaseModel()
        model.testDate = testDateTime

        await model.save()

        const loaded = await EdgeCaseModel.find(model.id)
        expect(loaded).not.toBeNull()
        expect(loaded!.testDate).toBeInstanceOf(DateTime)

        // Allow for small precision differences due to database storage
        const timeDiff = Math.abs(loaded!.testDate!.toMillis() - testDateTime.toMillis())
        expect(timeDiff).toBeLessThan(1) // Less than 1ms difference

        // Ensure year is preserved (not corrupted to 2000)
        expect(loaded!.testDate!.year).toBe(testDateTime.year)
      }
    })

    test('should handle timezone preservation', async () => {
      // Test various timezones
      const utcTime = DateTime.fromISO('2026-04-03T05:00:49.978Z')
      const estTime = DateTime.fromISO('2026-04-03T00:00:49.978-05:00')
      const pstTime = DateTime.fromISO('2026-04-02T22:00:49.978-08:00')

      for (const testDateTime of [utcTime, estTime, pstTime]) {
        const model = new EdgeCaseModel()
        model.testDate = testDateTime

        await model.save()

        const loaded = await EdgeCaseModel.find(model.id)
        expect(loaded).not.toBeNull()
        expect(loaded!.testDate).toBeInstanceOf(DateTime)

        // All should represent the same instant in time (allow for small timezone differences)
        const loadedUTC = loaded!.testDate!.toUTC()
        expect(loadedUTC.year).toBe(2026)
        expect(loadedUTC.month).toBe(4)
        expect(loadedUTC.day).toBe(3)
        // Allow for database timezone conversion, but ensure it's within an hour of expected
        expect(Math.abs(loadedUTC.hour - 5)).toBeLessThanOrEqual(1)
      }
    })
  })

  describe('Regression Tests', () => {
    test('should prevent the specific reported corruption case', async () => {
      class CorruptionTestModel extends BaseModel {
        @primary
        declare id: number

        @cast('json') // This decorator was likely causing the corruption
        declare problematicDate: DateTime

        static get tableName(): string {
          return 'datetime_test_models'
        }
      }

      // The exact case from the bug report
      const inputDateTime = DateTime.fromISO('2026-04-03T05:00:49.978+00:00')
      const corruptedDateTime = DateTime.fromISO('2000-01-01T00:00:00.000+00:00')

      const model = new CorruptionTestModel()
      model.problematicDate = inputDateTime

      // Save and reload
      await model.save()
      const loaded = await CorruptionTestModel.find(model.id)

      expect(loaded).not.toBeNull()
      expect(loaded!.problematicDate).toBeInstanceOf(DateTime)

      // Verify it's NOT corrupted to the 2000-01-01 date
      expect(loaded!.problematicDate.toISO()).not.toBe(corruptedDateTime.toISO())

      // Verify it preserves the original date
      expect(loaded!.problematicDate.toISO()).toBe(inputDateTime.toISO())
      expect(loaded!.problematicDate.year).toBe(2026)
      expect(loaded!.problematicDate.month).toBe(4)
      expect(loaded!.problematicDate.day).toBe(3)
    })
  })
})