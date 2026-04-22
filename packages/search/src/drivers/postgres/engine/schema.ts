import type { SQL } from 'bun'
import { quoteIdent, quoteLiteral, indexTableName, termsTableName, metaTableName, bareIndexTable, bareTermsTable } from '../storage/identifiers.ts'
import { MissingExtensionError } from '../errors.ts'
import type { FieldRegistry } from './field_registry.ts'
import type { ResolvedTypoTolerance } from '../types.ts'

const SCHEMA_VERSION = 1

/**
 * Idempotent: ensures the search schema, the shared `_meta` table, and the
 * required extensions exist. Called once per driver instantiation.
 */
export async function ensureSchemaAndExtensions(
  sql: SQL,
  schema: string,
  typo: ResolvedTypoTolerance
): Promise<void> {
  await sql.unsafe(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)}`)

  await sql.unsafe(`
    CREATE TABLE IF NOT EXISTS ${metaTableName(schema)} (
      index_name TEXT NOT NULL,
      key        TEXT NOT NULL,
      value      TEXT NOT NULL,
      PRIMARY KEY (index_name, key)
    )
  `)

  if (typo.enabled) {
    try {
      await sql.unsafe('CREATE EXTENSION IF NOT EXISTS pg_trgm')
    } catch {
      throw new MissingExtensionError('pg_trgm')
    }
    // fuzzystrmatch is optional — used to re-rank trigram candidates with a
    // bounded Levenshtein. If absent we silently fall back to trigram-only.
    try {
      await sql.unsafe('CREATE EXTENSION IF NOT EXISTS fuzzystrmatch')
    } catch {
      // ignore
    }
  }
}

/**
 * Idempotent: create the per-index table, GIN index, terms_dict, and trigger.
 * Returns true if the table was newly created (caller may seed `_meta`).
 */
export async function ensureIndexTable(
  sql: SQL,
  schema: string,
  index: string,
  registry: FieldRegistry,
  ginFastUpdate: boolean
): Promise<boolean> {
  const exists = await tableExists(sql, schema, bareIndexTable(index))
  if (exists) return false

  const typedColsDdl = registry.typedColumns
    .map(c => `, ${quoteIdent(c.name)} TEXT GENERATED ALWAYS AS (${c.expression}) STORED`)
    .join('')

  await sql.unsafe(`
    CREATE TABLE ${indexTableName(schema, index)} (
      id   TEXT PRIMARY KEY,
      doc  JSONB NOT NULL,
      fts  tsvector NOT NULL DEFAULT ''::tsvector${typedColsDdl}
    )
  `)

  await sql.unsafe(
    `CREATE INDEX ${quoteIdent(`${bareIndexTable(index)}_fts_gin`)} ` +
      `ON ${indexTableName(schema, index)} USING gin(fts) ` +
      `WITH (fastupdate = ${ginFastUpdate ? 'on' : 'off'})`
  )

  for (const col of registry.typedColumns) {
    await sql.unsafe(
      `CREATE INDEX ${quoteIdent(`${bareIndexTable(index)}_${col.name}_idx`)} ` +
        `ON ${indexTableName(schema, index)}(${quoteIdent(col.name)})`
    )
  }

  // Belt-and-suspenders: if anyone INSERTs without computing fts, recompute it
  // from doc using the current language + weight scheme. The driver always
  // sets fts itself; the trigger only fires when the caller didn't.
  await ensureFtsTrigger(sql, schema, index, registry)

  await ensureTermsDict(sql, schema, index)

  await sql.unsafe(
    `INSERT INTO ${metaTableName(schema)} (index_name, key, value) VALUES ` +
      `($1, 'schema_version', $2), ($1, 'language', $3), ($1, 'searchable', $4), ` +
      `($1, 'filterable', $5), ($1, 'sortable', $6) ` +
      `ON CONFLICT (index_name, key) DO NOTHING`,
    [
      index,
      String(SCHEMA_VERSION),
      registry.language,
      JSON.stringify(registry.searchable),
      JSON.stringify(registry.filterable),
      JSON.stringify(registry.sortable),
    ]
  )

  return true
}

export async function ensureTermsDict(sql: SQL, schema: string, index: string): Promise<void> {
  const exists = await tableExists(sql, schema, bareTermsTable(index))
  if (exists) return

  await sql.unsafe(`
    CREATE TABLE ${termsTableName(schema, index)} (
      term     TEXT PRIMARY KEY,
      doc_freq INTEGER NOT NULL DEFAULT 0
    )
  `)
  await sql.unsafe(
    `CREATE INDEX ${quoteIdent(`${bareTermsTable(index)}_trgm`)} ` +
      `ON ${termsTableName(schema, index)} USING gin (term gin_trgm_ops)`
  )
  await sql.unsafe(
    `CREATE INDEX ${quoteIdent(`${bareTermsTable(index)}_len`)} ` +
      `ON ${termsTableName(schema, index)} (length(term))`
  )
}

async function ensureFtsTrigger(
  sql: SQL,
  schema: string,
  index: string,
  registry: FieldRegistry
): Promise<void> {
  const fnName = `${bareIndexTable(index)}_fts_trigger`
  const lang = quoteLiteral(registry.language)
  const segments = registry.usesDefaultTextColumn
    ? `setweight(to_tsvector(${lang}::regconfig, ${defaultTextProjection()}), 'A')`
    : registry.searchable
        .map(attr => {
          const weight = registry.weights.get(attr)!
          return `setweight(to_tsvector(${lang}::regconfig, coalesce(NEW.doc->>${quoteLiteral(attr)}, '')), '${weight}')`
        })
        .join(' || ')

  await sql.unsafe(`
    CREATE OR REPLACE FUNCTION ${quoteIdent(schema)}.${quoteIdent(fnName)}() RETURNS trigger AS $$
    BEGIN
      IF NEW.fts IS NULL OR NEW.fts = ''::tsvector THEN
        NEW.fts := ${segments};
      END IF;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql
  `)

  await sql.unsafe(`
    CREATE TRIGGER ${quoteIdent(`${bareIndexTable(index)}_fts_trg`)}
    BEFORE INSERT OR UPDATE ON ${indexTableName(schema, index)}
    FOR EACH ROW EXECUTE FUNCTION ${quoteIdent(schema)}.${quoteIdent(fnName)}()
  `)
}

function defaultTextProjection(): string {
  // For default mode (no searchableAttributes) the trigger fallback walks
  // every JSONB string value — same shape as the field_registry default.
  return `(SELECT coalesce(string_agg(value, ' '), '') FROM jsonb_each_text(NEW.doc))`
}

async function tableExists(sql: SQL, schema: string, table: string): Promise<boolean> {
  const rows = (await sql.unsafe(
    `SELECT 1 AS present FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace ` +
      `WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'r' LIMIT 1`,
    [schema, table]
  )) as Array<Record<string, unknown>>
  return rows.length > 0
}

/** Drop a single index's tables and trigger function. Idempotent. */
export async function dropIndex(sql: SQL, schema: string, index: string): Promise<void> {
  await sql.unsafe(`DROP TABLE IF EXISTS ${indexTableName(schema, index)} CASCADE`)
  await sql.unsafe(`DROP TABLE IF EXISTS ${termsTableName(schema, index)} CASCADE`)
  await sql.unsafe(
    `DROP FUNCTION IF EXISTS ${quoteIdent(schema)}.${quoteIdent(`${bareIndexTable(index)}_fts_trigger`)}() CASCADE`
  )
  await sql.unsafe(`DELETE FROM ${metaTableName(schema)} WHERE index_name = $1`, [index])
}
