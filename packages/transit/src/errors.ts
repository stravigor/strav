import { StravError } from '@strav/kernel'

export class TransitError extends StravError {}

export class TooManyErrorsError extends TransitError {
  constructor(public readonly limit: number) {
    super(`Import aborted: more than ${limit} row errors`)
  }
}

export class CsvParseError extends TransitError {
  constructor(message: string, public readonly position?: number) {
    super(`CSV parse error: ${message}${position !== undefined ? ` at position ${position}` : ''}`)
  }
}

/**
 * Thrown when `dedupBy()`'s in-memory set exceeds `maxDedupKeys()`.
 * Memory safeguard against unbounded growth on adversarial input.
 */
export class DedupKeyLimitError extends TransitError {
  constructor(public readonly limit: number) {
    super(
      `dedupBy exceeded maxDedupKeys (${limit}). ` +
        `Either tighten the source, raise the cap with .maxDedupKeys(N), ` +
        `or use DB-native deduplication (UNIQUE index + upsertInto, or DISTINCT ON).`
    )
  }
}
