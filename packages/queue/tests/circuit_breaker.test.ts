import { afterEach, describe, expect, test } from 'bun:test'
import {
  configureBreaker,
  checkBreaker,
  recordFailure,
  recordSuccess,
  resetBreakers,
} from '../src/queue/circuit_breaker.ts'

afterEach(() => {
  resetBreakers()
})

describe('circuit breaker', () => {
  test('checkBreaker returns null for unconfigured handlers', () => {
    expect(checkBreaker('not-configured')).toBeNull()
  })

  test('threshold trips the circuit', () => {
    configureBreaker('flaky', { threshold: 3, windowMs: 60_000, cooldownMs: 5_000 })
    const now = 1_000

    expect(recordFailure('flaky', now)).toBeNull()
    expect(recordFailure('flaky', now + 100)).toBeNull()
    // Third failure within the window — trip.
    const cooldown = recordFailure('flaky', now + 200)
    expect(cooldown).toBe(5_000)
    expect(checkBreaker('flaky', now + 200)).toBe(5_000)
  })

  test('failures outside the window are not counted', () => {
    configureBreaker('flaky', { threshold: 3, windowMs: 1_000, cooldownMs: 5_000 })

    recordFailure('flaky', 0)
    recordFailure('flaky', 500)
    // Third failure 2s later — first two have aged out of the 1s window.
    expect(recordFailure('flaky', 2_500)).toBeNull()
    expect(checkBreaker('flaky', 2_500)).toBeNull()
  })

  test('cooldown expiry closes the circuit and resets failures', () => {
    configureBreaker('flaky', { threshold: 2, windowMs: 60_000, cooldownMs: 1_000 })

    recordFailure('flaky', 0)
    recordFailure('flaky', 100) // trips at timestamp 100; trippedUntil = 1100
    expect(checkBreaker('flaky', 500)).toBe(600) // 1100 - 500

    // After cooldown, circuit closes.
    expect(checkBreaker('flaky', 1_200)).toBeNull()

    // And the failure window starts fresh — one more failure does not re-trip.
    expect(recordFailure('flaky', 1_300)).toBeNull()
    expect(checkBreaker('flaky', 1_300)).toBeNull()
  })

  test('recordSuccess clears the failure history when not tripped', () => {
    configureBreaker('flaky', { threshold: 3, windowMs: 60_000, cooldownMs: 5_000 })

    recordFailure('flaky', 0)
    recordFailure('flaky', 100)
    recordSuccess('flaky')

    // Two new failures should not trip — history was cleared.
    expect(recordFailure('flaky', 200)).toBeNull()
    expect(recordFailure('flaky', 300)).toBeNull()
    expect(checkBreaker('flaky', 300)).toBeNull()
  })

  test('recordSuccess does not close a tripped circuit', () => {
    configureBreaker('flaky', { threshold: 2, windowMs: 60_000, cooldownMs: 5_000 })

    recordFailure('flaky', 0)
    recordFailure('flaky', 100) // trips at 100; trippedUntil = 5100
    expect(checkBreaker('flaky', 500)).toBe(4_600) // 5100 - 500

    recordSuccess('flaky')
    // Still tripped — only cooldown can close.
    expect(checkBreaker('flaky', 500)).toBe(4_600)
  })

  test('default options: threshold 10, windowMs 60_000, cooldownMs 30_000', () => {
    configureBreaker('default-handler', {})
    for (let i = 0; i < 9; i++) {
      expect(recordFailure('default-handler', i)).toBeNull()
    }
    expect(recordFailure('default-handler', 9)).toBe(30_000)
  })

  test('resetBreakers clears all state', () => {
    configureBreaker('flaky', { threshold: 1, windowMs: 60_000, cooldownMs: 5_000 })
    recordFailure('flaky', 0) // trips at threshold 1
    expect(checkBreaker('flaky', 0)).toBeGreaterThan(0)

    resetBreakers()

    expect(checkBreaker('flaky', 0)).toBeNull()
  })
})
