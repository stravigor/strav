import { describe, expect, test } from 'bun:test'
import { signRequest, verifySignature } from '../src/webhook/signature.ts'
import { nextDelayMs, shouldDeadLetter } from '../src/webhook/retry_policy.ts'

const SECRET = 'wh_test_secret'

describe('signRequest', () => {
  test('produces all required headers', () => {
    const now = new Date(1714600000_000)
    const headers = signRequest(SECRET, 'lead.created', 'd-1', '{"id":1}', now)

    expect(headers['X-Strav-Delivery']).toBe('d-1')
    expect(headers['X-Strav-Event']).toBe('lead.created')
    expect(headers['X-Strav-Timestamp']).toBe('1714600000')
    expect(headers['X-Strav-Signature']).toMatch(/^sha256=[0-9a-f]{64}$/)
    expect(headers['Content-Type']).toBe('application/json')
    expect(headers['User-Agent']).toContain('strav-webhooks')
  })

  test('signature changes when body changes', () => {
    const now = new Date(1714600000_000)
    const a = signRequest(SECRET, 'e', 'd', '{"a":1}', now)
    const b = signRequest(SECRET, 'e', 'd', '{"a":2}', now)
    expect(a['X-Strav-Signature']).not.toBe(b['X-Strav-Signature'])
  })

  test('signature changes when timestamp changes', () => {
    const a = signRequest(SECRET, 'e', 'd', '{}', new Date(1714600000_000))
    const b = signRequest(SECRET, 'e', 'd', '{}', new Date(1714600001_000))
    expect(a['X-Strav-Signature']).not.toBe(b['X-Strav-Signature'])
  })
})

describe('verifySignature', () => {
  test('round-trips a valid signature', () => {
    const now = new Date(1714600000_000)
    const headers = signRequest(SECRET, 'e', 'd', '{"x":1}', now)
    const ok = verifySignature({
      secret: SECRET,
      body: '{"x":1}',
      timestamp: headers['X-Strav-Timestamp'],
      signature: headers['X-Strav-Signature'],
      now,
    })
    expect(ok).toBe(true)
  })

  test('rejects a tampered body', () => {
    const now = new Date(1714600000_000)
    const headers = signRequest(SECRET, 'e', 'd', '{"x":1}', now)
    const ok = verifySignature({
      secret: SECRET,
      body: '{"x":2}',
      timestamp: headers['X-Strav-Timestamp'],
      signature: headers['X-Strav-Signature'],
      now,
    })
    expect(ok).toBe(false)
  })

  test('rejects a wrong secret', () => {
    const now = new Date(1714600000_000)
    const headers = signRequest(SECRET, 'e', 'd', '{}', now)
    const ok = verifySignature({
      secret: 'wrong',
      body: '{}',
      timestamp: headers['X-Strav-Timestamp'],
      signature: headers['X-Strav-Signature'],
      now,
    })
    expect(ok).toBe(false)
  })

  test('rejects stale timestamps', () => {
    const old = new Date(1714600000_000)
    const headers = signRequest(SECRET, 'e', 'd', '{}', old)
    const future = new Date(old.getTime() + 10 * 60 * 1000) // 10min later
    const ok = verifySignature({
      secret: SECRET,
      body: '{}',
      timestamp: headers['X-Strav-Timestamp'],
      signature: headers['X-Strav-Signature'],
      now: future,
      maxAgeSeconds: 300,
    })
    expect(ok).toBe(false)
  })

  test('tolerates missing sha256= prefix', () => {
    const now = new Date(1714600000_000)
    const headers = signRequest(SECRET, 'e', 'd', '{}', now)
    const bare = headers['X-Strav-Signature'].slice('sha256='.length)
    const ok = verifySignature({
      secret: SECRET,
      body: '{}',
      timestamp: headers['X-Strav-Timestamp'],
      signature: bare,
      now,
    })
    expect(ok).toBe(true)
  })
})

describe('retry policy', () => {
  const cfg = {
    driver: 'memory',
    maxAttempts: 5,
    baseDelayMs: 1000,
    factor: 2,
    ceilingMs: 60_000,
    jitter: 0,
    responseBodyLimit: 65_536,
    fetchTimeoutMs: 15_000,
  }

  test('exponential growth without jitter', () => {
    expect(nextDelayMs(1, cfg)).toBe(1000)
    expect(nextDelayMs(2, cfg)).toBe(2000)
    expect(nextDelayMs(3, cfg)).toBe(4000)
    expect(nextDelayMs(4, cfg)).toBe(8000)
  })

  test('respects the ceiling', () => {
    expect(nextDelayMs(20, cfg)).toBe(60_000)
  })

  test('jitter stays within bounds', () => {
    const jittered = { ...cfg, jitter: 0.2 }
    for (let i = 0; i < 50; i++) {
      const d = nextDelayMs(2, jittered)
      // 2000 ± 20% → 1600..2400
      expect(d).toBeGreaterThanOrEqual(1600)
      expect(d).toBeLessThanOrEqual(2400)
    }
  })

  test('shouldDeadLetter compares attempt count to maxAttempts', () => {
    expect(shouldDeadLetter(4, cfg)).toBe(false)
    expect(shouldDeadLetter(5, cfg)).toBe(true)
    expect(shouldDeadLetter(6, cfg)).toBe(true)
  })
})
