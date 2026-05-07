import { describe, test, expect } from 'bun:test'
import './setup.ts'
import { sealToken, unsealToken, hashAnswer, safeEqual, consumeReplay } from '../src/token.ts'
import { MemoryCacheStore } from '@strav/kernel'

describe('token codec', () => {
  test('seal/unseal roundtrip preserves payload', () => {
    const { token, payload } = sealToken({ t: 'svg', s: 'salt', exp: 10, ah: 'somehash' })
    const result = unsealToken(token)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.payload.t).toBe('svg')
    expect(result.payload.s).toBe('salt')
    expect(result.payload.ah).toBe('somehash')
    expect(result.payload.jti).toBe(payload.jti)
    expect(typeof result.payload.iat).toBe('number')
  })

  test('tampered token fails to unseal', () => {
    const { token } = sealToken({ t: 'svg', s: 'salt', exp: 10 })
    const tampered = token.slice(0, -2) + 'XX'
    const result = unsealToken(tampered)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('token_invalid')
  })

  test('expired token rejected', async () => {
    const { token, payload } = sealToken({ t: 'svg', s: 'salt', exp: 0 })
    // Force iat back so the token is past expiry
    void payload
    // Simulate expiry by waiting one ms past exp=0 (already expired)
    await new Promise(resolve => setTimeout(resolve, 5))
    const result = unsealToken(token)
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('token_expired')
  })

  test('hashAnswer is deterministic and salted', () => {
    expect(hashAnswer('abc123', 's1')).toBe(hashAnswer('ABC123', 's1'))
    expect(hashAnswer('abc123', 's1')).not.toBe(hashAnswer('abc123', 's2'))
    expect(hashAnswer('  abc ', 's1')).toBe(hashAnswer('abc', 's1'))
  })

  test('safeEqual returns true for equal strings, false otherwise', () => {
    expect(safeEqual('abc', 'abc')).toBe(true)
    expect(safeEqual('abc', 'abd')).toBe(false)
    expect(safeEqual('abc', 'abcd')).toBe(false)
  })

  test('consumeReplay marks jti once', async () => {
    const store = new MemoryCacheStore()
    const { payload } = sealToken({ t: 'svg', s: 'salt', exp: 10 })
    const first = await consumeReplay(store, payload)
    expect(first).toBe(true)
    const second = await consumeReplay(store, payload)
    expect(second).toBe(false)
  })
})
