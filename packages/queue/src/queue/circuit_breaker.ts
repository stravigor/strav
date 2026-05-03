/**
 * Per-handler circuit breaker. Tracks recent failure timestamps in
 * memory; trips the circuit when the failure count within the window
 * exceeds the threshold and pauses dispatch of that handler for
 * `cooldownMs`. Dispatches are auto-resumed once the cooldown expires.
 *
 * Intended defense against retry storms — a handler that consistently
 * fails (stale schema, downed dependency) shouldn't keep eating worker
 * cycles and DB connections. Tripping pushes failed jobs back to the
 * queue with a delay so they retry AFTER the cooldown.
 *
 * State is per-process (in-memory). Multi-worker deployments will each
 * track independently — that's fine; each worker self-pauses without
 * cross-talk, and a handler that's failing for a global reason will
 * trip every worker quickly.
 */

import Emitter from '@strav/kernel/events/emitter'

export interface CircuitBreakerOptions {
  /** Number of failures within the window that trips the breaker. Default: 10. */
  threshold?: number
  /** Window in ms over which failures are counted. Default: 60_000 (1 min). */
  windowMs?: number
  /** Cooldown in ms after tripping before retry resumes. Default: 30_000 (30 s). */
  cooldownMs?: number
}

export interface ResolvedBreakerOptions {
  threshold: number
  windowMs: number
  cooldownMs: number
}

interface BreakerState {
  options: ResolvedBreakerOptions
  failures: number[] // unix-ms timestamps, recent-first not enforced
  trippedUntil: number | null // unix-ms; null when closed
}

const DEFAULTS: ResolvedBreakerOptions = {
  threshold: 10,
  windowMs: 60_000,
  cooldownMs: 30_000,
}

const breakers = new Map<string, BreakerState>()

/** Register / update a breaker for a handler. */
export function configureBreaker(handlerName: string, options: CircuitBreakerOptions): void {
  breakers.set(handlerName, {
    options: { ...DEFAULTS, ...options },
    failures: [],
    trippedUntil: null,
  })
}

/** Forget all breaker state. Test-only. */
export function resetBreakers(): void {
  breakers.clear()
}

/**
 * Check if a handler is currently tripped. Returns the remaining
 * cooldown in ms (>= 0) when tripped, or `null` when the circuit is
 * closed (handler is dispatchable). Auto-resets state when the
 * cooldown has elapsed and emits `queue:circuit_reset` once on
 * transition.
 */
export function checkBreaker(handlerName: string, now: number = Date.now()): number | null {
  const state = breakers.get(handlerName)
  if (!state) return null
  if (state.trippedUntil === null) return null

  if (now >= state.trippedUntil) {
    // Cooldown expired — close the circuit. Reset failure history so
    // the next set of failures starts a fresh window.
    state.trippedUntil = null
    state.failures = []
    if (Emitter.listenerCount('queue:circuit_reset') > 0) {
      void Emitter.emit('queue:circuit_reset', { handler: handlerName }).catch(() => {})
    }
    return null
  }

  return state.trippedUntil - now
}

/**
 * Record a failure for a handler. Trips the circuit when the failure
 * count within `windowMs` reaches `threshold`. Returns the new cooldown
 * (ms) when tripping, or `null` when the threshold is not yet reached.
 */
export function recordFailure(handlerName: string, now: number = Date.now()): number | null {
  const state = breakers.get(handlerName)
  if (!state) return null

  // Drop failures outside the window then push the new one.
  const cutoff = now - state.options.windowMs
  state.failures = state.failures.filter(t => t > cutoff)
  state.failures.push(now)

  if (state.trippedUntil !== null) {
    // Already tripped — do nothing.
    return state.trippedUntil - now
  }

  if (state.failures.length >= state.options.threshold) {
    state.trippedUntil = now + state.options.cooldownMs
    if (Emitter.listenerCount('queue:circuit_tripped') > 0) {
      void Emitter.emit('queue:circuit_tripped', {
        handler: handlerName,
        threshold: state.options.threshold,
        windowMs: state.options.windowMs,
        cooldownMs: state.options.cooldownMs,
        trippedUntil: state.trippedUntil,
      }).catch(() => {})
    }
    return state.options.cooldownMs
  }

  return null
}

/**
 * Record a success — clears the failure history for this handler so
 * intermittent errors don't accumulate. Does NOT close a tripped
 * circuit (only the cooldown expiry does).
 */
export function recordSuccess(handlerName: string): void {
  const state = breakers.get(handlerName)
  if (!state) return
  if (state.trippedUntil !== null) return
  state.failures = []
}
