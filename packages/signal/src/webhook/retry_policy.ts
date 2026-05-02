import type { WebhookConfig } from './types.ts'

/**
 * Compute the delay (in ms) before the next retry attempt.
 *
 * Exponential backoff with optional jitter: `min(baseDelay * factor^(attempt-1), ceiling) * (1 ± jitter)`.
 *
 * `attempt` is 1-indexed (after the first failure, attempt=1 → first retry).
 */
export function nextDelayMs(attempt: number, cfg: WebhookConfig): number {
  if (attempt < 1) return 0
  const exp = Math.pow(cfg.factor, attempt - 1)
  const raw = Math.min(cfg.baseDelayMs * exp, cfg.ceilingMs)
  const j = cfg.jitter
  if (j <= 0) return Math.round(raw)
  // Symmetric jitter ratio: multiplier in [1-j, 1+j]
  const multiplier = 1 - j + Math.random() * 2 * j
  return Math.round(raw * multiplier)
}

/** True when the attempt count has reached the configured ceiling. */
export function shouldDeadLetter(attempts: number, cfg: WebhookConfig): boolean {
  return attempts >= cfg.maxAttempts
}
