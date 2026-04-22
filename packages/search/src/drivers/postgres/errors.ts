import { SearchError } from '../../errors.ts'

export class PostgresFtsError extends SearchError {}

export class MissingExtensionError extends PostgresFtsError {
  constructor(extension: string) {
    super(
      `Postgres extension "${extension}" is required by the postgres-fts driver. ` +
        `Run \`CREATE EXTENSION ${extension}\` as a superuser, or set typoTolerance: 'off' if you can't.`
    )
  }
}

export class RebuildRequiredError extends PostgresFtsError {
  constructor(message: string) {
    super(message)
  }
}

export class UnsupportedFilterError extends PostgresFtsError {
  constructor(message: string) {
    super(`Postgres-fts driver filter is unsupported: ${message}`)
  }
}

export class MissingConnectionError extends PostgresFtsError {
  constructor() {
    super(
      'PostgresFtsDriver has no Postgres connection. ' +
        'Pass `connection` in the driver config, or bootstrap @strav/database first so Database.raw is available.'
    )
  }
}
