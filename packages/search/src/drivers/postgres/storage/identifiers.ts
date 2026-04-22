import { PostgresFtsError } from '../errors.ts'

const PG_IDENT_MAX = 63

/**
 * Quote a Postgres identifier (schema, table, column). Throws on identifiers
 * containing NUL or exceeding the 63-byte name limit.
 */
export function quoteIdent(name: string): string {
  if (name.includes('\0')) throw new PostgresFtsError(`Invalid identifier: contains NUL byte.`)
  if (Buffer.byteLength(name, 'utf8') > PG_IDENT_MAX) {
    throw new PostgresFtsError(
      `Identifier "${name}" exceeds Postgres' ${PG_IDENT_MAX}-byte limit.`
    )
  }
  return `"${name.replace(/"/g, '""')}"`
}

/** Quote a single-quoted SQL string literal (used inside DDL options). */
export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`
}

/** Build the schema-qualified table name for a search index. */
export function indexTableName(schema: string, index: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(`search_${index}`)}`
}

/** Terms-dictionary table name for a given index. */
export function termsTableName(schema: string, index: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(`search_${index}_terms`)}`
}

/** Meta table — single shared table; rows keyed by (index_name, key). */
export function metaTableName(schema: string): string {
  return `${quoteIdent(schema)}.${quoteIdent('_meta')}`
}

/** Bare (unquoted) tablename — useful for pg_class lookups. */
export function bareIndexTable(index: string): string {
  return `search_${index}`
}

export function bareTermsTable(index: string): string {
  return `search_${index}_terms`
}
