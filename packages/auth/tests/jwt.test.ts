import { describe, test, expect } from 'bun:test'
import {
  signJWT,
  verifyJWT,
  createAccessToken,
  verifyAccessToken,
  createRefreshToken,
  verifyRefreshToken,
  decodeJWT,
} from '../src/jwt/index.ts'

describe('JWT utilities', () => {
  const secret = 'test-secret-key-for-testing-only'

  test('signJWT and verifyJWT work together', async () => {
    const payload = { userId: 123, role: 'admin' }
    const token = await signJWT(payload, secret, {
      expiresIn: '1h',
      issuer: 'test-app',
    })

    expect(typeof token).toBe('string')
    expect(token.split('.')).toHaveLength(3) // JWT has 3 parts

    const verified = await verifyJWT(token, secret, {
      issuer: 'test-app',
    })

    expect(verified.userId).toBe(123)
    expect(verified.role).toBe('admin')
    expect(verified.iss).toBe('test-app')
  })

  test('createAccessToken and verifyAccessToken', async () => {
    const userId = 'user-456'
    const token = await createAccessToken(userId, secret, {
      email: 'test@example.com',
    })

    const verifiedUserId = await verifyAccessToken(token, secret)
    expect(verifiedUserId).toBe(userId)
  })

  test('createRefreshToken and verifyRefreshToken', async () => {
    const userId = 'user-789'
    const token = await createRefreshToken(userId, secret)

    const verifiedUserId = await verifyRefreshToken(token, secret)
    expect(verifiedUserId).toBe(userId)
  })

  test('verifyJWT rejects expired tokens', async () => {
    const token = await signJWT({ test: true }, secret, {
      expiresIn: '0s', // Already expired
    })

    // Wait a moment to ensure expiration
    await new Promise(resolve => setTimeout(resolve, 10))

    expect(verifyJWT(token, secret)).rejects.toThrow()
  })

  test('verifyJWT rejects invalid signature', async () => {
    const token = await signJWT({ test: true }, secret)
    const wrongSecret = 'wrong-secret'

    expect(verifyJWT(token, wrongSecret)).rejects.toThrow()
  })

  test('decodeJWT decodes without verification', () => {
    const token = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJ1c2VyIjoxMjMsImlhdCI6MTUxNjIzOTAyMn0.invalid'
    const decoded = decodeJWT(token)

    expect(decoded.user).toBe(123)
    expect(decoded.iat).toBe(1516239022)
  })
})