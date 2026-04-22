import { SearchError } from '../../errors.ts'

export class EmbeddedSearchError extends SearchError {}

export class IndexCorruptError extends EmbeddedSearchError {
  constructor(index: string, cause: string) {
    super(`Embedded search index "${index}" is corrupt: ${cause}`)
  }
}

export class UnsupportedFilterError extends EmbeddedSearchError {
  constructor(message: string) {
    super(`Embedded driver filter is unsupported: ${message}`)
  }
}
