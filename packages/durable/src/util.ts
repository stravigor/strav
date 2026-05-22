/**
 * Parse a JSONB column value. Bun's SQL driver may return a JSONB column as
 * either an already-parsed object or a raw string depending on context — this
 * normalizes both. `null`/`undefined` pass through unchanged.
 */
export function parseJson<T = unknown>(value: unknown): T {
  if (value == null) return value as T
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T
    } catch {
      return value as T
    }
  }
  return value as T
}

/** Compute the retry backoff delay (ms) for a given attempt number. */
export function backoffDelay(
  attempt: number,
  strategy: 'exponential' | 'linear'
): number {
  if (strategy === 'linear') return attempt * 5_000
  return Math.pow(2, attempt) * 1_000 + Math.random() * 1_000
}
