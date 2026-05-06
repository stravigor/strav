import { expect, test, describe, beforeAll, afterAll } from 'bun:test'
import { DateTime } from 'luxon'
import { Container } from '@strav/kernel/core'
import Configuration from '@strav/kernel/config/configuration'
import Database from '../src/database/database'
import { BaseModel, cast, primary } from '../src/orm'
import { sql } from '../src/database'
import { ulid } from '@strav/kernel/helpers'

describe('VerificationToken DateTime Corruption Regression', () => {
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

    // Create test tables matching your schema
    await sql`
      DROP TABLE IF EXISTS verification_token_test
    `
    await sql`
      DROP TABLE IF EXISTS user_test
    `

    await sql`
      CREATE TABLE user_test (
        id VARCHAR(26) PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        name VARCHAR(255) NOT NULL,
        is_active BOOLEAN DEFAULT true,
        email_verified BOOLEAN DEFAULT false,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `

    await sql`
      CREATE TABLE verification_token_test (
        id VARCHAR(26) PRIMARY KEY,
        user_id VARCHAR(26) NOT NULL REFERENCES user_test(id),
        secret VARCHAR(255) NOT NULL,
        public VARCHAR(255) NOT NULL,
        reference VARCHAR(255),
        type VARCHAR(50) NOT NULL,
        revoked BOOLEAN DEFAULT false,
        sent_at TIMESTAMPTZ NULL,
        expires_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `
  })

  afterAll(async () => {
    // Clean up
    await sql`DROP TABLE IF EXISTS verification_token_test`
    await sql`DROP TABLE IF EXISTS user_test`
    await db.close()
  })

  // Simulate the User model
  class UserTest extends BaseModel {
    @primary
    declare id: string

    declare email: string
    declare password: string
    declare name: string
    declare isActive: boolean
    declare emailVerified: boolean
    declare createdAt: DateTime
    declare updatedAt: DateTime

    static get tableName(): string {
      return 'user_test'
    }
  }

  // Simulate the VerificationToken model with potential problematic @cast decorators
  class VerificationTokenTest extends BaseModel {
    @primary
    declare id: string

    declare userId: string
    declare secret: string
    declare public: string
    declare reference: string | null
    declare type: string
    declare revoked: boolean
    declare sentAt: DateTime | null

    // This field might have had a @cast decorator that was causing corruption
    // We'll test both with and without cast to verify our fix
    declare expiresAt: DateTime

    declare createdAt: DateTime
    declare updatedAt: DateTime

    static get tableName(): string {
      return 'verification_token_test'
    }
  }

  // Test with @cast decorator to simulate the problematic scenario
  class VerificationTokenWithCast extends BaseModel {
    @primary
    declare id: string

    declare userId: string
    declare secret: string
    declare public: string
    declare reference: string | null
    declare type: string
    declare revoked: boolean
    declare sentAt: DateTime | null

    // This @cast decorator would have caused the corruption before our fix
    @cast('json')
    declare expiresAt: DateTime

    declare createdAt: DateTime
    declare updatedAt: DateTime

    static get tableName(): string {
      return 'verification_token_test'
    }
  }

  test('demonstrates the original DateTime corruption scenario', async () => {
    // Create a user first to satisfy foreign key constraint
    const user = new UserTest()
    user.id = ulid()
    user.email = 'test@example.com'
    user.password = 'hashedpassword123'
    user.name = 'Test User'
    user.isActive = true
    user.emailVerified = false
    await user.save()

    // Create the exact DateTime that was being corrupted
    const testDateTime = DateTime.fromISO('2026-12-25T10:30:00.000Z')
    console.log('Original DateTime:', testDateTime.toString())

    // Create a new VerificationToken model instance
    const token = new VerificationTokenTest()
    token.id = ulid()
    token.userId = user.id
    token.secret = 'test-secret-40-characters-long-exactly!!!'
    token.public = 'test-public-40-characters-long-exactly!!!'
    token.reference = 'ref123'
    token.type = 'Account'
    token.revoked = false
    token.sentAt = null

    // Set the expiresAt to our test DateTime
    token.expiresAt = testDateTime
    console.log('Before save - token.expiresAt:', token.expiresAt.toString())

    // Save the model to database
    await token.save()
    console.log('After save - token.expiresAt:', token.expiresAt.toString())

    // Fetch the token from database to see what was actually stored
    const dbToken = await VerificationTokenTest.find(token.id)
    console.log('From database - dbToken.expiresAt:', dbToken?.expiresAt.toString())

    // With our fix, these should now pass (before fix, they would fail)
    expect(token.expiresAt.toString()).toBe(testDateTime.toString())
    expect(dbToken?.expiresAt.toString()).toBe(testDateTime.toString())

    // Specifically test that it's NOT corrupted to the Y2K date
    expect(token.expiresAt.year).toBe(2026) // Not 2000
    expect(dbToken?.expiresAt.year).toBe(2026) // Not 2000

    // Verify the exact values
    expect(token.expiresAt.month).toBe(12)
    expect(token.expiresAt.day).toBe(25)
    expect(dbToken?.expiresAt.month).toBe(12)
    expect(dbToken?.expiresAt.day).toBe(25)
  })

  test('verifies fix with @cast decorator that was causing corruption', async () => {
    // This test uses the VerificationTokenWithCast model that has @cast('json')
    // which was likely the source of the original corruption

    const user = new UserTest()
    user.id = ulid()
    user.email = 'test2@example.com'
    user.password = 'hashedpassword123'
    user.name = 'Test User 2'
    user.isActive = true
    user.emailVerified = false
    await user.save()

    // Use the exact same DateTime from the bug report
    const testDateTime = DateTime.fromISO('2026-12-25T10:30:00.000Z')

    const token = new VerificationTokenWithCast()
    token.id = ulid()
    token.userId = user.id
    token.secret = 'test-secret-40-characters-long-exactly!!!'
    token.public = 'test-public-40-characters-long-exactly!!!'
    token.reference = 'ref123'
    token.type = 'Account'
    token.revoked = false
    token.sentAt = null
    token.expiresAt = testDateTime

    // Save the model with @cast('json') decorator
    await token.save()

    // Fetch from database
    const dbToken = await VerificationTokenWithCast.find(token.id)

    // With our fix, even with @cast decorator, DateTime should be preserved
    expect(token.expiresAt.year).toBe(2026) // Should NOT be 2000
    expect(dbToken?.expiresAt.year).toBe(2026) // Should NOT be 2000

    expect(token.expiresAt.toString()).toBe(testDateTime.toString())
    expect(dbToken?.expiresAt.toString()).toBe(testDateTime.toString())

    console.log('✅ Fix verified: DateTime with @cast decorator preserved correctly')
    console.log('Before fix: would have been 2000-01-01T00:00:00.000+00:00')
    console.log('After fix:', dbToken?.expiresAt.toString())
  })

  test('verifies no corruption across multiple DateTime operations', async () => {
    const user = new UserTest()
    user.id = ulid()
    user.email = 'test3@example.com'
    user.password = 'hashedpassword123'
    user.name = 'Test User 3'
    user.isActive = true
    user.emailVerified = false
    await user.save()

    // Test multiple DateTime values to ensure consistency
    const testDates = [
      DateTime.fromISO('2026-04-03T05:00:49.978+00:00'), // From original bug report
      DateTime.fromISO('2026-12-25T10:30:00.000Z'), // From your test
      DateTime.fromISO('2025-01-01T00:00:00.000Z'), // Edge case: near Y2K
      DateTime.fromISO('2030-06-15T14:45:30.123-07:00'), // Different timezone
    ]

    for (const [index, testDateTime] of testDates.entries()) {
      const token = new VerificationTokenWithCast()
      token.id = ulid()
      token.userId = user.id
      token.secret = `test-secret-${index}-40-chars-exactly!!!!!!`
      token.public = `test-public-${index}-40-chars-exactly!!!!!!`
      token.reference = `ref${index}`
      token.type = 'Account'
      token.revoked = false
      token.sentAt = null
      token.expiresAt = testDateTime

      await token.save()

      const dbToken = await VerificationTokenWithCast.find(token.id)

      // Verify no corruption occurred
      expect(dbToken?.expiresAt.year).toBe(testDateTime.year)
      expect(dbToken?.expiresAt.month).toBe(testDateTime.month)
      expect(dbToken?.expiresAt.day).toBe(testDateTime.day)

      // Ensure it's not corrupted to 2000-01-01
      expect(dbToken?.expiresAt.year).not.toBe(2000)
      if (testDateTime.month !== 1 || testDateTime.day !== 1) {
        expect(dbToken?.expiresAt.month).not.toBe(1)
        expect(dbToken?.expiresAt.day).not.toBe(1)
      }
    }
  })
})