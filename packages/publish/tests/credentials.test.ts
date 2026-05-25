import { describe, expect, test } from 'bun:test'
import PublisherCredentials from '../src/credentials/credentials.ts'
import { makeCredentials } from './_fixtures.ts'

describe('PublisherCredentials.isExpired', () => {
  test('returns false when expiresAt is null (non-expiring credential)', () => {
    expect(PublisherCredentials.isExpired(makeCredentials({ expiresAt: null }))).toBe(false)
  })

  test('returns false when expiresAt is comfortably in the future', () => {
    const future = new Date(Date.now() + 60 * 60 * 1000) // +1h
    expect(PublisherCredentials.isExpired(makeCredentials({ expiresAt: future }))).toBe(false)
  })

  test('returns true when expiresAt is in the past', () => {
    const past = new Date(Date.now() - 1000)
    expect(PublisherCredentials.isExpired(makeCredentials({ expiresAt: past }))).toBe(true)
  })

  test('treats tokens expiring inside the default 60s skew window as expired', () => {
    const inThirty = new Date(Date.now() + 30 * 1000)
    expect(PublisherCredentials.isExpired(makeCredentials({ expiresAt: inThirty }))).toBe(true)
  })

  test('honours a custom skew value', () => {
    const inFive = new Date(Date.now() + 5 * 1000)
    expect(PublisherCredentials.isExpired(makeCredentials({ expiresAt: inFive }), 1)).toBe(false)
    expect(PublisherCredentials.isExpired(makeCredentials({ expiresAt: inFive }), 10)).toBe(true)
  })
})
