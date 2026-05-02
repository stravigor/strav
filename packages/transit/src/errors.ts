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
