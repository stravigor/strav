import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import EncryptionManager from '../src/encryption/encryption_manager.ts'
import { encrypt } from '../src/encryption/helpers.ts'
import { ConfigurationError } from '../src/exceptions/errors.ts'

const APP_KEY = 'test-key-for-blind-index-only'

beforeEach(() => {
  EncryptionManager.useKey(APP_KEY)
})

afterEach(() => {
  // Reset to a fresh key between tests so cached blind-index keys don't bleed
  EncryptionManager.useKey(APP_KEY)
})

describe('EncryptionManager.blindIndex', () => {
  test('returns a 64-char hex string by default', () => {
    const idx = EncryptionManager.blindIndex('alice@example.com', 'users.email')
    expect(idx).toMatch(/^[0-9a-f]{64}$/)
  })

  test('is deterministic for the same value, context, and key', () => {
    const a = EncryptionManager.blindIndex('alice@example.com', 'users.email')
    const b = EncryptionManager.blindIndex('alice@example.com', 'users.email')
    expect(a).toBe(b)
  })

  test('different contexts produce different indexes for the same value', () => {
    const a = EncryptionManager.blindIndex('alice@example.com', 'users.email')
    const b = EncryptionManager.blindIndex('alice@example.com', 'leads.email')
    expect(a).not.toBe(b)
  })

  test('different values produce different indexes within the same context', () => {
    const a = EncryptionManager.blindIndex('alice@example.com', 'users.email')
    const b = EncryptionManager.blindIndex('bob@example.com', 'users.email')
    expect(a).not.toBe(b)
  })

  test('different keys produce different indexes for the same value', () => {
    const a = EncryptionManager.blindIndex('alice@example.com', 'users.email')
    EncryptionManager.useKey('a-totally-different-key')
    const b = EncryptionManager.blindIndex('alice@example.com', 'users.email')
    expect(a).not.toBe(b)
  })

  test('truncates to the requested byte length (length * 2 hex chars)', () => {
    const idx = EncryptionManager.blindIndex('alice@example.com', 'users.email', { length: 16 })
    expect(idx).toHaveLength(32)
    expect(idx).toMatch(/^[0-9a-f]{32}$/)
  })

  test('truncated index is a prefix of the full index', () => {
    const full = EncryptionManager.blindIndex('alice@example.com', 'users.email')
    const short = EncryptionManager.blindIndex('alice@example.com', 'users.email', { length: 8 })
    expect(full.startsWith(short)).toBe(true)
  })

  test('clamps unreasonable length values', () => {
    const tiny = EncryptionManager.blindIndex('alice@example.com', 'c', { length: 0 })
    expect(tiny).toHaveLength(2) // clamped to 1 byte minimum
    const huge = EncryptionManager.blindIndex('alice@example.com', 'c', { length: 999 })
    expect(huge).toHaveLength(64) // clamped to full 32 bytes
  })

  test('default context lookup pattern works', () => {
    const a = EncryptionManager.blindIndex('alice@example.com')
    const b = EncryptionManager.blindIndex('alice@example.com', 'default')
    expect(a).toBe(b)
  })

  test('throws ConfigurationError when EncryptionManager has no key', () => {
    // Reset internal state by clearing the config — emulate "not configured"
    ;(EncryptionManager as any)._config = undefined
    expect(() => EncryptionManager.blindIndex('x')).toThrow(ConfigurationError)
    EncryptionManager.useKey(APP_KEY)
  })
})

describe('EncryptionManager.searchablePair', () => {
  test('returns a fresh ciphertext + a deterministic index', () => {
    const a = EncryptionManager.searchablePair('alice@example.com', 'users.email')
    const b = EncryptionManager.searchablePair('alice@example.com', 'users.email')

    // Indexes match (deterministic)
    expect(a.index).toBe(b.index)
    // Ciphertexts differ (random IV per encrypt call)
    expect(a.encrypted).not.toBe(b.encrypted)
    // Both decrypt back to the original
    expect(EncryptionManager.decrypt(a.encrypted)).toBe('alice@example.com')
    expect(EncryptionManager.decrypt(b.encrypted)).toBe('alice@example.com')
  })

  test('honors the length option', () => {
    const pair = EncryptionManager.searchablePair('phone', 'contacts.phone', { length: 16 })
    expect(pair.index).toHaveLength(32)
  })
})

describe('encrypt helper exposes the same surface', () => {
  test('encrypt.blindIndex matches EncryptionManager.blindIndex', () => {
    const a = encrypt.blindIndex('alice@example.com', 'users.email')
    const b = EncryptionManager.blindIndex('alice@example.com', 'users.email')
    expect(a).toBe(b)
  })

  test('encrypt.searchablePair returns the encrypted+index pair', () => {
    const { encrypted, index } = encrypt.searchablePair('alice@example.com', 'users.email')
    expect(encrypt.decrypt(encrypted)).toBe('alice@example.com')
    expect(index).toMatch(/^[0-9a-f]{64}$/)
  })
})
