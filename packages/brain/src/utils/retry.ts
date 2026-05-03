import { ExternalServiceError } from '@strav/kernel'
import { scrubProviderError } from './error_scrub.ts'

export interface RetryOptions {
  maxRetries?: number
  baseDelay?: number
  maxDelay?: number
  retryableStatuses?: number[]
}

const DEFAULT_RETRYABLE = [429, 500, 502, 503, 529]

/**
 * Fetch with automatic retry and exponential backoff for transient errors.
 *
 * Retries on 429 (rate limit), 5xx, and network failures.
 * Parses the `retry-after` header when available; otherwise uses
 * exponential backoff with jitter.
 *
 * Returns the successful `Response`. On final failure, throws
 * `ExternalServiceError` with the last status and body.
 */
export async function retryableFetch(
  service: string,
  url: string,
  init: RequestInit,
  options?: RetryOptions
): Promise<Response> {
  const maxRetries = options?.maxRetries ?? 3
  const baseDelay = options?.baseDelay ?? 1000
  const maxDelay = options?.maxDelay ?? 60_000
  const retryable = options?.retryableStatuses ?? DEFAULT_RETRYABLE

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let response: Response

    try {
      response = await fetch(url, init)
    } catch (err) {
      // Network error (DNS, connection refused, etc.). Some Bun/Node
      // network errors include the URL — scrub before surfacing in
      // case it carries credentials in query params.
      if (attempt === maxRetries) {
        throw new ExternalServiceError(
          service,
          undefined,
          scrubProviderError(err instanceof Error ? err.message : String(err))
        )
      }
      await sleep(backoffDelay(attempt, baseDelay, maxDelay))
      continue
    }

    if (response.ok) return response

    // Non-retryable status — fail immediately. Provider response bodies
    // can echo request headers or other context; scrub before wrapping.
    if (!retryable.includes(response.status)) {
      const text = await response.text()
      throw new ExternalServiceError(service, response.status, scrubProviderError(text))
    }

    // Retryable status — wait and retry (unless last attempt)
    if (attempt === maxRetries) {
      const text = await response.text()
      throw new ExternalServiceError(service, response.status, scrubProviderError(text))
    }

    const delay = parseRetryAfter(response) ?? backoffDelay(attempt, baseDelay, maxDelay)
    await sleep(delay)
  }

  // Unreachable, but satisfies TypeScript
  throw new ExternalServiceError(service, undefined, 'Retry loop exited unexpectedly')
}

/**
 * Parse the `retry-after` header into milliseconds.
 * Supports both delta-seconds ("2") and HTTP-date formats.
 */
function parseRetryAfter(response: Response): number | null {
  const header = response.headers.get('retry-after')
  if (!header) return null

  const seconds = Number(header)
  if (!Number.isNaN(seconds)) return seconds * 1000

  // HTTP-date format
  const date = Date.parse(header)
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now())

  return null
}

/** Exponential backoff with jitter: base * 2^attempt + random jitter, capped at maxDelay. */
function backoffDelay(attempt: number, baseDelay: number, maxDelay: number): number {
  const exp = baseDelay * 2 ** attempt
  const jitter = Math.random() * baseDelay
  return Math.min(exp + jitter, maxDelay)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
