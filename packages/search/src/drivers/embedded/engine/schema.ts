import type { Database } from 'bun:sqlite'
import type { FieldRegistry } from './field_registry.ts'

const SCHEMA_VERSION = 1

/** Quote a SQLite identifier (column or table). Throws on identifiers that contain a NUL byte. */
export function quoteIdent(name: string): string {
  if (name.includes('\0')) throw new Error(`Invalid identifier: ${name}`)
  return `"${name.replace(/"/g, '""')}"`
}

export function applyConnectionPragmas(
  db: Database,
  synchronous: 'OFF' | 'NORMAL' | 'FULL'
): void {
  db.exec('PRAGMA journal_mode = WAL')
  db.exec(`PRAGMA synchronous = ${synchronous}`)
  db.exec('PRAGMA temp_store = MEMORY')
  db.exec('PRAGMA foreign_keys = ON')
}

/**
 * Create the documents + FTS5 + terms_dict tables for a fresh index.
 * Idempotent: skips creation if `_meta` already exists.
 */
export function createSchema(db: Database, registry: FieldRegistry): void {
  if (schemaExists(db)) return

  db.exec(`
    CREATE TABLE _meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `)

  const typedColumns = registry.typedColumns
    .map(c => `${quoteIdent(c)} BLOB`)
    .join(', ')
  const typedColumnsClause = typedColumns ? `, ${typedColumns}` : ''

  db.exec(`
    CREATE TABLE documents (
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      doc TEXT NOT NULL${typedColumnsClause}
    )
  `)
  db.exec('CREATE UNIQUE INDEX documents_id_idx ON documents(id)')

  // One index per filterable column so WHERE clauses can use it.
  for (const col of registry.filterable) {
    db.exec(`CREATE INDEX ${quoteIdent(`documents_${col}_idx`)} ON documents(${quoteIdent(col)})`)
  }

  const ftsCols = registry.searchable.map(quoteIdent).join(', ')
  // FTS5 default mode (no `content` option): the original text is stored in
  // FTS5 itself so `snippet()` can echo it back highlighted. The Porter
  // tokenizer applies English stemming; unicode61 normalises and folds
  // diacritics so accented input matches its ASCII form.
  db.exec(`
    CREATE VIRTUAL TABLE fts USING fts5(
      ${ftsCols},
      tokenize = 'porter unicode61 remove_diacritics 2'
    )
  `)

  // Maintain a terms dictionary for typo expansion.
  db.exec(`
    CREATE TABLE terms_dict (
      term TEXT PRIMARY KEY,
      doc_freq INTEGER NOT NULL DEFAULT 0
    )
  `)
  db.exec('CREATE INDEX terms_dict_len_idx ON terms_dict(length(term))')

  // Persist registry layout so we can detect mismatches on reopen.
  const stmt = db.prepare('INSERT INTO _meta (key, value) VALUES (?, ?)')
  stmt.run('schema_version', String(SCHEMA_VERSION))
  stmt.run('searchable', JSON.stringify(registry.searchable))
  stmt.run('filterable', JSON.stringify(registry.filterable))
  stmt.run('sortable', JSON.stringify(registry.sortable))
  stmt.run('primary_key', registry.primaryKey)
}

function schemaExists(db: Database): boolean {
  const row = db
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='_meta'"
    )
    .get()
  return row !== null
}

export function readMeta(db: Database, key: string): string | null {
  const row = db
    .query<{ value: string }, [string]>('SELECT value FROM _meta WHERE key = ?')
    .get(key)
  return row ? row.value : null
}
