import { test, expect, describe, beforeEach } from 'bun:test'
import {
  bootOAuth2,
  resetStores,
  createMockUser,
  resetUserStore,
  getAuthCodeStore,
} from './helpers.ts'
import OAuthClient from '../src/client.ts'
import AuthCode from '../src/auth_code.ts'

beforeEach(() => {
  resetStores()
  resetUserStore()
  bootOAuth2()
})

describe('AuthCode', () => {
  async function createTestClient() {
    const { client } = await OAuthClient.create({
      name: 'Test App',
      redirectUris: ['https://example.com/callback'],
    })
    return client
  }

  describe('create', () => {
    test('creates an authorization code', async () => {
      const client = await createTestClient()
      const user = createMockUser()

      const { code, codeData } = await AuthCode.create({
        clientId: client.id,
        userId: String(user.id),
        redirectUri: 'https://example.com/callback',
        scopes: ['read'],
      })

      expect(code).toBeDefined()
      expect(code.length).toBe(80) // 40 bytes hex
      expect(codeData.clientId).toBe(client.id)
      expect(codeData.userId).toBe(String(user.id))
      expect(codeData.scopes).toEqual(['read'])
      expect(codeData.usedAt).toBeNull()

      // Code in store should be hashed
      const stored = getAuthCodeStore()[0]!
      expect(stored.code).not.toBe(code)
    })

    test('creates code with PKCE challenge', async () => {
      const client = await createTestClient()
      const user = createMockUser()

      const { codeData } = await AuthCode.create({
        clientId: client.id,
        userId: String(user.id),
        redirectUri: 'https://example.com/callback',
        scopes: [],
        codeChallenge: 'challenge123',
        codeChallengeMethod: 'S256',
      })

      expect(codeData.codeChallenge).toBe('challenge123')
      expect(codeData.codeChallengeMethod).toBe('S256')
    })
  })

  describe('consume', () => {
    test('consumes a valid authorization code', async () => {
      const client = await createTestClient()
      const user = createMockUser()

      const { code } = await AuthCode.create({
        clientId: client.id,
        userId: String(user.id),
        redirectUri: 'https://example.com/callback',
        scopes: ['read'],
      })

      const consumed = await AuthCode.consume(code, client.id, 'https://example.com/callback')
      expect(consumed).not.toBeNull()
      expect(consumed!.scopes).toEqual(['read'])
      expect(consumed!.userId).toBe(String(user.id))

      // Should be marked as used
      const stored = getAuthCodeStore()[0]!
      expect(stored.used_at).not.toBeNull()
    })

    test('returns null for wrong client', async () => {
      const client = await createTestClient()
      const user = createMockUser()

      const { code } = await AuthCode.create({
        clientId: client.id,
        userId: String(user.id),
        redirectUri: 'https://example.com/callback',
        scopes: [],
      })

      const consumed = await AuthCode.consume(code, 'wrong-client', 'https://example.com/callback')
      expect(consumed).toBeNull()
    })

    test('returns null for wrong redirect_uri', async () => {
      const client = await createTestClient()
      const user = createMockUser()

      const { code } = await AuthCode.create({
        clientId: client.id,
        userId: String(user.id),
        redirectUri: 'https://example.com/callback',
        scopes: [],
      })

      const consumed = await AuthCode.consume(code, client.id, 'https://evil.com/callback')
      expect(consumed).toBeNull()
    })

    test('returns null for already-used code (replay protection)', async () => {
      const client = await createTestClient()
      const user = createMockUser()

      const { code } = await AuthCode.create({
        clientId: client.id,
        userId: String(user.id),
        redirectUri: 'https://example.com/callback',
        scopes: [],
      })

      // First use succeeds
      const first = await AuthCode.consume(code, client.id, 'https://example.com/callback')
      expect(first).not.toBeNull()

      // Second use fails
      const second = await AuthCode.consume(code, client.id, 'https://example.com/callback')
      expect(second).toBeNull()
    })

    test('returns null for expired code', async () => {
      const client = await createTestClient()
      const user = createMockUser()

      // Create code, then manually expire it
      const { code } = await AuthCode.create({
        clientId: client.id,
        userId: String(user.id),
        redirectUri: 'https://example.com/callback',
        scopes: [],
      })

      // Manually expire
      getAuthCodeStore()[0]!.expires_at = new Date(Date.now() - 1000)

      const consumed = await AuthCode.consume(code, client.id, 'https://example.com/callback')
      expect(consumed).toBeNull()
    })

    test('validates PKCE S256 code_verifier', async () => {
      const client = await createTestClient()
      const user = createMockUser()

      // Generate a PKCE pair
      const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
      const challenge = new Bun.CryptoHasher('sha256').update(verifier).digest('base64url')

      const { code } = await AuthCode.create({
        clientId: client.id,
        userId: String(user.id),
        redirectUri: 'https://example.com/callback',
        scopes: [],
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
      })

      // Correct verifier
      const consumed = await AuthCode.consume(
        code,
        client.id,
        'https://example.com/callback',
        verifier
      )
      expect(consumed).not.toBeNull()
    })

    test('rejects wrong PKCE code_verifier', async () => {
      const client = await createTestClient()
      const user = createMockUser()

      const verifier = 'correct-verifier'
      const challenge = new Bun.CryptoHasher('sha256').update(verifier).digest('base64url')

      const { code } = await AuthCode.create({
        clientId: client.id,
        userId: String(user.id),
        redirectUri: 'https://example.com/callback',
        scopes: [],
        codeChallenge: challenge,
        codeChallengeMethod: 'S256',
      })

      const consumed = await AuthCode.consume(
        code,
        client.id,
        'https://example.com/callback',
        'wrong-verifier'
      )
      expect(consumed).toBeNull()
    })

    test('rejects missing code_verifier when challenge is set', async () => {
      const client = await createTestClient()
      const user = createMockUser()

      const { code } = await AuthCode.create({
        clientId: client.id,
        userId: String(user.id),
        redirectUri: 'https://example.com/callback',
        scopes: [],
        codeChallenge: 'some-challenge',
        codeChallengeMethod: 'S256',
      })

      // No verifier provided
      const consumed = await AuthCode.consume(code, client.id, 'https://example.com/callback')
      expect(consumed).toBeNull()
    })

    test('validates PKCE plain method', async () => {
      const client = await createTestClient()
      const user = createMockUser()

      const verifier = 'my-plain-verifier'

      const { code } = await AuthCode.create({
        clientId: client.id,
        userId: String(user.id),
        redirectUri: 'https://example.com/callback',
        scopes: [],
        codeChallenge: verifier,
        codeChallengeMethod: 'plain',
      })

      const consumed = await AuthCode.consume(
        code,
        client.id,
        'https://example.com/callback',
        verifier
      )
      expect(consumed).not.toBeNull()
    })

    test('atomic single-use: concurrent consumes — exactly one wins', async () => {
      const client = await createTestClient()
      const user = createMockUser()

      const { code } = await AuthCode.create({
        clientId: client.id,
        userId: String(user.id),
        redirectUri: 'https://example.com/callback',
        scopes: [],
      })

      const [a, b] = await Promise.all([
        AuthCode.consume(code, client.id, 'https://example.com/callback'),
        AuthCode.consume(code, client.id, 'https://example.com/callback'),
      ])

      const winners = [a, b].filter(r => r !== null)
      expect(winners).toHaveLength(1)
    })

    test('failed validation still burns the code (replay-prevention)', async () => {
      // The atomic UPDATE marks the row as used BEFORE post-checks
      // (expired / redirect_uri / PKCE). A subsequent legitimate
      // consume must still get null — the code is one-shot.
      const client = await createTestClient()
      const user = createMockUser()

      const { code } = await AuthCode.create({
        clientId: client.id,
        userId: String(user.id),
        redirectUri: 'https://example.com/callback',
        scopes: [],
      })

      // First call: wrong redirect_uri → null AND code is now burned.
      const first = await AuthCode.consume(code, client.id, 'https://attacker.example/callback')
      expect(first).toBeNull()

      // Second call: correct redirect_uri → still null, code already used.
      const second = await AuthCode.consume(code, client.id, 'https://example.com/callback')
      expect(second).toBeNull()
    })
  })

  describe('prune', () => {
    test('prunes expired and used codes', async () => {
      const client = await createTestClient()
      const user = createMockUser()

      // Create and expire a code
      await AuthCode.create({
        clientId: client.id,
        userId: String(user.id),
        redirectUri: 'https://example.com/callback',
        scopes: [],
      })
      getAuthCodeStore()[0]!.expires_at = new Date(Date.now() - 1000)

      // Create and use a code
      const { code } = await AuthCode.create({
        clientId: client.id,
        userId: String(user.id),
        redirectUri: 'https://example.com/callback',
        scopes: [],
      })
      await AuthCode.consume(code, client.id, 'https://example.com/callback')

      // Create a valid code (should not be pruned)
      await AuthCode.create({
        clientId: client.id,
        userId: String(user.id),
        redirectUri: 'https://example.com/callback',
        scopes: [],
      })

      const pruned = await AuthCode.prune()
      expect(pruned).toBe(2)
      expect(getAuthCodeStore()).toHaveLength(1)
    })
  })
})
