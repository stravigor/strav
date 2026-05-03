import { describe, test, expect, beforeEach, mock } from 'bun:test'
import { EncryptionManager } from '@strav/kernel'
import SocialAccount from '../src/social_account.ts'
import SocialManager from '../src/social_manager.ts'
import type { SocialUser } from '../src/types.ts'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const sampleRow = {
  id: 1,
  user_id: '42',
  provider: 'github',
  provider_id: 'gh-999',
  token: 'tok',
  refresh_token: 'rtok',
  expires_at: new Date('2025-12-31'),
  created_at: new Date('2025-01-01'),
  updated_at: new Date('2025-01-01'),
}

function mockDb(rows: Record<string, unknown>[] = []) {
  const sqlFn = Object.assign(() => Promise.resolve(rows), { unsafe: () => Promise.resolve(rows) })
  return { sql: sqlFn } as any
}

function mockConfig(data: Record<string, unknown>) {
  return {
    get(key: string, defaultValue?: unknown): unknown {
      const parts = key.split('.')
      let current: any = data
      for (const part of parts) {
        if (current === undefined || current === null) return defaultValue
        current = current[part]
      }
      return current !== undefined ? current : defaultValue
    },
  } as any
}

function setupManager(rows: Record<string, unknown>[] = [], userKey = 'id') {
  new SocialManager(mockDb(rows), mockConfig({ social: { userKey, providers: {} } }))
}

function socialUser(overrides: Partial<SocialUser> = {}): SocialUser {
  return {
    id: 'gh-999',
    name: 'Test User',
    email: 'test@example.com',
    emailVerified: true,
    avatar: null,
    nickname: 'tester',
    token: 'new-token',
    refreshToken: 'new-refresh',
    expiresIn: 3600,
    approvedScopes: [],
    raw: {},
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SocialAccount', () => {
  beforeEach(() => {
    EncryptionManager.useKey('test-key-for-social-account')
    setupManager()
  })

  describe('findByProvider', () => {
    test('returns null when no rows', async () => {
      setupManager([])
      const result = await SocialAccount.findByProvider('github', 'nonexistent')
      expect(result).toBeNull()
    })

    test('returns hydrated record when row exists', async () => {
      setupManager([sampleRow])
      const result = await SocialAccount.findByProvider('github', 'gh-999')
      expect(result).not.toBeNull()
      expect(result!.id).toBe(1)
      expect(result!.userId).toBe('42')
      expect(result!.provider).toBe('github')
      expect(result!.providerId).toBe('gh-999')
      expect(result!.token).toBe('tok')
      expect(result!.refreshToken).toBe('rtok')
    })
  })

  describe('findByUser', () => {
    test('uses the configured FK column', async () => {
      const calls: string[] = []
      const db = {
        sql: Object.assign(() => Promise.resolve([]), {
          unsafe: (query: string) => {
            calls.push(query)
            return Promise.resolve([])
          },
        }),
      } as any
      new SocialManager(db, mockConfig({ social: { userKey: 'uid', providers: {} } }))

      await SocialAccount.findByUser('user-123')
      expect(calls.length).toBeGreaterThan(0)
      expect(calls[0]).toContain('user_uid')
    })

    test('returns array of hydrated records', async () => {
      setupManager([sampleRow, { ...sampleRow, id: 2, provider: 'google', provider_id: 'g-111' }])
      const results = await SocialAccount.findByUser('42')
      expect(results).toHaveLength(2)
    })
  })

  describe('create', () => {
    test('calls sql.unsafe with FK column and returns hydrated record', async () => {
      const calls: { query: string; params: any[] }[] = []
      const db = {
        sql: Object.assign(() => Promise.resolve([]), {
          unsafe: (query: string, params: any[]) => {
            calls.push({ query, params })
            return Promise.resolve([sampleRow])
          },
        }),
      } as any
      new SocialManager(db, mockConfig({ social: { providers: {} } }))

      const result = await SocialAccount.create({
        user: '42',
        provider: 'github',
        providerId: 'gh-999',
        token: 'tok',
      })

      expect(result.id).toBe(1)
      expect(calls[0].query).toContain('user_id')
      expect(calls[0].params[0]).toBe('42')
    })

    test('encrypts token and refresh_token before persisting', async () => {
      const calls: { query: string; params: any[] }[] = []
      const db = {
        sql: Object.assign(() => Promise.resolve([]), {
          unsafe: (query: string, params: any[]) => {
            calls.push({ query, params })
            return Promise.resolve([sampleRow])
          },
        }),
      } as any
      new SocialManager(db, mockConfig({ social: { providers: {} } }))

      await SocialAccount.create({
        user: '42',
        provider: 'github',
        providerId: 'gh-999',
        token: 'plaintext-access',
        refreshToken: 'plaintext-refresh',
      })

      const [, , , storedToken, storedRefresh] = calls[0].params
      expect(storedToken).toMatch(/^enc:v1:/)
      expect(storedToken).not.toContain('plaintext-access')
      expect(storedRefresh).toMatch(/^enc:v1:/)
      expect(storedRefresh).not.toContain('plaintext-refresh')
    })

    test('passes null refresh token through unencrypted', async () => {
      const calls: { params: any[] }[] = []
      const db = {
        sql: Object.assign(() => Promise.resolve([]), {
          unsafe: (_query: string, params: any[]) => {
            calls.push({ params })
            return Promise.resolve([sampleRow])
          },
        }),
      } as any
      new SocialManager(db, mockConfig({ social: { providers: {} } }))

      await SocialAccount.create({
        user: '42',
        provider: 'github',
        providerId: 'gh-999',
        token: 'tok',
        refreshToken: null,
      })

      expect(calls[0].params[4]).toBeNull()
    })
  })

  describe('hydrate (encryption round-trip)', () => {
    test('decrypts an encrypted token on read', async () => {
      // Encrypt a known plaintext using the test key, then place it in a
      // sample row and read it back through findByProvider → hydrate.
      const { EncryptionManager } = await import('@strav/kernel')
      const stored = 'enc:v1:' + EncryptionManager.encrypt('round-trip-token')
      const storedRefresh = 'enc:v1:' + EncryptionManager.encrypt('round-trip-refresh')

      setupManager([{ ...sampleRow, token: stored, refresh_token: storedRefresh }])
      const result = await SocialAccount.findByProvider('github', 'gh-999')

      expect(result!.token).toBe('round-trip-token')
      expect(result!.refreshToken).toBe('round-trip-refresh')
    })

    test('passes legacy plaintext tokens through unchanged (backward compat)', async () => {
      // No 'enc:v1:' prefix → row is from before encryption-at-rest landed.
      // Must not throw and must return the plaintext as-is.
      setupManager([{ ...sampleRow, token: 'legacy-plain', refresh_token: 'legacy-refresh' }])
      const result = await SocialAccount.findByProvider('github', 'gh-999')

      expect(result!.token).toBe('legacy-plain')
      expect(result!.refreshToken).toBe('legacy-refresh')
    })
  })

  describe('findOrCreate', () => {
    test('creates when no existing account', async () => {
      let callCount = 0
      const db = {
        sql: Object.assign(
          () => {
            callCount++
            // First call (findByProvider) returns empty, third call (updateTokens) is skipped
            return Promise.resolve([])
          },
          {
            unsafe: (_query: string, _params: any[]) => {
              callCount++
              // create call returns the row
              return Promise.resolve([sampleRow])
            },
          }
        ),
      } as any
      new SocialManager(db, mockConfig({ social: { providers: {} } }))

      const { account, created } = await SocialAccount.findOrCreate('github', socialUser(), '42')
      expect(created).toBe(true)
      expect(account.id).toBe(1)
    })

    test('updates tokens when account exists', async () => {
      let updateCalled = false
      const db = {
        sql: Object.assign(
          (..._args: any[]) => {
            // Tagged template calls — first is findByProvider (returns row), second is updateTokens
            if (!updateCalled) {
              updateCalled = true
              return Promise.resolve([sampleRow]) // findByProvider returns existing
            }
            return Promise.resolve([]) // updateTokens
          },
          { unsafe: () => Promise.resolve([]) }
        ),
      } as any
      new SocialManager(db, mockConfig({ social: { providers: {} } }))

      const { account, created } = await SocialAccount.findOrCreate('github', socialUser(), '42')
      expect(created).toBe(false)
      expect(account.token).toBe('new-token')
    })
  })

  describe('delete', () => {
    test('calls sql tagged template with id', async () => {
      setupManager()
      // Should not throw
      await SocialAccount.delete(1)
    })
  })

  describe('deleteByUser', () => {
    test('uses the configured FK column', async () => {
      const calls: string[] = []
      const db = {
        sql: Object.assign(() => Promise.resolve([]), {
          unsafe: (query: string) => {
            calls.push(query)
            return Promise.resolve([])
          },
        }),
      } as any
      new SocialManager(db, mockConfig({ social: { userKey: 'uid', providers: {} } }))

      await SocialAccount.deleteByUser('user-123')
      expect(calls[0]).toContain('user_uid')
    })
  })

  describe('userFkColumn defaults', () => {
    test('defaults to user_id when no userKey configured', () => {
      setupManager()
      expect(SocialManager.userFkColumn).toBe('user_id')
    })

    test('uses custom userKey', () => {
      setupManager([], 'uid')
      expect(SocialManager.userFkColumn).toBe('user_uid')
    })

    test('snake_cases the key', () => {
      setupManager([], 'publicId')
      expect(SocialManager.userFkColumn).toBe('user_public_id')
    })
  })
})
