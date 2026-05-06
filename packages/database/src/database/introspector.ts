import type Database from './database'
import type {
  DatabaseRepresentation,
  TableDefinition,
  ColumnDefinition,
  EnumDefinition,
  ForeignKeyConstraint,
  PrimaryKeyConstraint,
  UniqueConstraint,
  IndexDefinition,
  DefaultValue,
} from '../schema/database_representation'
import type { PostgreSQLType, PostgreSQLCustomType } from '../schema/postgres'

/** Maps PostgreSQL internal type names to our PostgreSQLType union. */
const PG_TYPE_MAP: Record<string, PostgreSQLType> = {
  int2: 'smallint',
  int4: 'integer',
  int8: 'bigint',
  float4: 'real',
  float8: 'double_precision',
  bool: 'boolean',
  varchar: 'varchar',
  bpchar: 'char',
  text: 'text',
  uuid: 'uuid',
  json: 'json',
  jsonb: 'jsonb',
  bytea: 'bytea',
  xml: 'xml',
  inet: 'inet',
  cidr: 'cidr',
  macaddr: 'macaddr',
  macaddr8: 'macaddr8',
  money: 'money',
  numeric: 'numeric',
  timestamp: 'timestamp',
  timestamptz: 'timestamptz',
  date: 'date',
  time: 'time',
  timetz: 'timetz',
  interval: 'interval',
  point: 'point',
  line: 'line',
  lseg: 'lseg',
  box: 'box',
  path: 'path',
  polygon: 'polygon',
  circle: 'circle',
  tsvector: 'tsvector',
  tsquery: 'tsquery',
  int4range: 'int4range',
  int8range: 'int8range',
  numrange: 'numrange',
  tsrange: 'tsrange',
  tstzrange: 'tstzrange',
  daterange: 'daterange',
  bit: 'bit',
  varbit: 'bit_varying',
}

/** Maps integer types to their serial counterparts (for serial detection). */
const INTEGER_TO_SERIAL: Record<string, PostgreSQLType> = {
  smallint: 'smallserial',
  integer: 'serial',
  bigint: 'bigserial',
}

/**
 * Introspects a live PostgreSQL database and produces a {@link DatabaseRepresentation}
 * that matches the same structure built by the schema's {@link RepresentationBuilder}.
 *
 * Only inspects the `public` schema.
 *
 * @example
 * const introspector = new DatabaseIntrospector(db)
 * const rep = await introspector.introspect()
 */
export default class DatabaseIntrospector {
  constructor(private db: Database) {}

  async introspect(): Promise<DatabaseRepresentation> {
    const enums = await this.loadEnums()
    const enumNames = new Set(enums.map(e => e.name))
    const tableNames = await this.loadTables()
    const tenantedSequenceTables = await this.loadTenantedSequenceTriggers()

    const tables: TableDefinition[] = []
    for (const name of tableNames) {
      tables.push(await this.loadTable(name, enumNames, tenantedSequenceTables.has(name)))
    }

    return { enums, tables }
  }

  private async loadTable(
    name: string,
    enumNames: Set<string>,
    hasTenantedSequence: boolean
  ): Promise<TableDefinition> {
    const [columns, primaryKey, foreignKeys, uniqueConstraints, indexes] = await Promise.all([
      this.loadColumns(name, enumNames),
      this.loadPrimaryKey(name),
      this.loadForeignKeys(name),
      this.loadUniqueConstraints(name),
      this.loadIndexes(name),
    ])

    // Mark PK columns
    if (primaryKey) {
      const pkSet = new Set(primaryKey.columns)
      for (const col of columns) {
        if (pkSet.has(col.name)) col.primaryKey = true
      }
    }

    // Mark tenanted-sequence id column so the differ matches the desired
    // representation built from t.tenantedSerial() / t.tenantedBigSerial().
    if (hasTenantedSequence) {
      const idCol = columns.find(c => c.name === 'id')
      if (idCol) idCol.tenantedSequence = true
    }

    // Mark single-column unique constraints on the column
    for (const uc of uniqueConstraints) {
      if (uc.columns.length === 1) {
        const col = columns.find(c => c.name === uc.columns[0])
        if (col) col.unique = true
      }
    }

    // Mark indexed columns
    for (const idx of indexes) {
      if (idx.columns.length === 1) {
        const col = columns.find(c => c.name === idx.columns[0])
        if (col) col.index = true
      }
    }

    return { name, columns, primaryKey, foreignKeys, uniqueConstraints, indexes }
  }

  // --- Enums ---

  private async loadEnums(): Promise<EnumDefinition[]> {
    const rows = await this.db.sql`
      SELECT t.typname AS name, e.enumlabel AS value
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
      WHERE t.typnamespace = (
        SELECT oid FROM pg_namespace WHERE nspname = 'public'
      )
      ORDER BY t.typname, e.enumsortorder
    `

    const map = new Map<string, string[]>()
    for (const row of rows) {
      const values = map.get(row.name) ?? []
      values.push(row.value)
      map.set(row.name, values)
    }

    return Array.from(map.entries()).map(([name, values]) => ({ name, values }))
  }

  // --- Tables ---

  private async loadTables(): Promise<string[]> {
    // Exclude framework-internal tables only. The tenant registry table is
    // expected to be defined by a user schema with `tenantRegistry: true`,
    // so it appears in the diff like any other table.
    const rows = await this.db.sql`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
        AND table_name NOT IN ('_strav_migrations', '_strav_tenant_sequences')
      ORDER BY table_name
    `
    return rows.map((r: any) => r.table_name)
  }

  /**
   * Returns the set of table names that have a `*_assign_tenanted_id` BEFORE
   * INSERT trigger installed. Used to mark introspected columns as
   * `tenantedSequence: true` so the differ doesn't try to "fix" them.
   */
  private async loadTenantedSequenceTriggers(): Promise<Set<string>> {
    const rows = await this.db.sql`
      SELECT c.relname AS table_name
      FROM pg_trigger tg
      JOIN pg_class c ON c.oid = tg.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND NOT tg.tgisinternal
        AND tg.tgname LIKE '%_assign_tenanted_id'
    `
    return new Set(rows.map((r: any) => r.table_name as string))
  }

  // --- Columns ---

  private async loadColumns(table: string, enumNames: Set<string>): Promise<ColumnDefinition[]> {
    const rows = await this.db.sql`
      SELECT
        column_name,
        udt_name,
        data_type,
        is_nullable,
        column_default,
        character_maximum_length,
        numeric_precision,
        numeric_scale
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = ${table}
      ORDER BY ordinal_position
    `

    return rows.map((row: any) => this.rowToColumn(row, enumNames))
  }

  private rowToColumn(row: any, enumNames: Set<string>): ColumnDefinition {
    const udtName: string = row.udt_name
    const dataType: string = row.data_type
    const columnDefault: string | null = row.column_default
    const notNull = row.is_nullable === 'NO'

    let pgType = this.mapPgType(udtName, dataType, enumNames)
    let autoIncrement = false
    let isArray = false
    let arrayDimensions = 1

    // Serial detection: integer + nextval() default
    if (columnDefault?.startsWith('nextval(')) {
      const pgTypeStr = typeof pgType === 'string' ? pgType : null
      if (pgTypeStr && pgTypeStr in INTEGER_TO_SERIAL) {
        pgType = INTEGER_TO_SERIAL[pgTypeStr]!
        autoIncrement = true
      }
    }

    // Array detection: data_type = 'ARRAY' and udt_name starts with '_'
    if (dataType === 'ARRAY' && udtName.startsWith('_')) {
      isArray = true
      const elementType = udtName.slice(1) // remove leading '_'
      pgType = {
        type: 'array',
        element: this.mapPgType(elementType, elementType, enumNames) as any,
      }
    }

    const defaultValue = autoIncrement ? undefined : this.parseDefault(columnDefault, pgType)

    return {
      name: row.column_name,
      pgType,
      notNull,
      defaultValue,
      unique: false, // filled later from constraints
      primaryKey: false, // filled later from PK constraint
      autoIncrement,
      index: false, // filled later from indexes
      isArray,
      arrayDimensions,
      length: row.character_maximum_length ?? undefined,
      precision: row.numeric_precision ?? undefined,
      scale: row.numeric_scale ?? undefined,
    }
  }

  // --- Primary Key ---

  private async loadPrimaryKey(table: string): Promise<PrimaryKeyConstraint | null> {
    const rows = await this.db.sql`
      SELECT kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = tc.constraint_name
        AND kcu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'PRIMARY KEY'
        AND tc.table_schema = 'public'
        AND tc.table_name = ${table}
      ORDER BY kcu.ordinal_position
    `

    if (rows.length === 0) return null

    const columns = rows.map((r: any) => r.column_name)

    return { columns }
  }

  // --- Foreign Keys ---

  private async loadForeignKeys(table: string): Promise<ForeignKeyConstraint[]> {
    const rows = await this.db.sql`
      SELECT
        tc.constraint_name,
        kcu.column_name,
        ccu.table_name AS referenced_table,
        ccu.column_name AS referenced_column,
        rc.delete_rule,
        rc.update_rule
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = tc.constraint_name
        AND kcu.table_schema = tc.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_name = tc.constraint_name
        AND ccu.table_schema = tc.table_schema
      JOIN information_schema.referential_constraints rc
        ON rc.constraint_name = tc.constraint_name
        AND rc.constraint_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = 'public'
        AND tc.table_name = ${table}
      ORDER BY tc.constraint_name, kcu.ordinal_position
    `

    // Group by constraint name (for composite FKs)
    const map = new Map<string, ForeignKeyConstraint>()
    for (const row of rows) {
      const key = row.constraint_name
      if (!map.has(key)) {
        map.set(key, {
          columns: [],
          referencedTable: row.referenced_table,
          referencedColumns: [],
          onDelete: this.normalizeRule(row.delete_rule),
          onUpdate: this.normalizeRule(row.update_rule),
        })
      }
      const fk = map.get(key)!
      fk.columns.push(row.column_name)
      fk.referencedColumns.push(row.referenced_column)
    }

    return Array.from(map.values())
  }

  // --- Unique Constraints ---

  private async loadUniqueConstraints(table: string): Promise<UniqueConstraint[]> {
    const rows = await this.db.sql`
      SELECT tc.constraint_name, kcu.column_name
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_name = tc.constraint_name
        AND kcu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'UNIQUE'
        AND tc.table_schema = 'public'
        AND tc.table_name = ${table}
      ORDER BY tc.constraint_name, kcu.ordinal_position
    `

    const map = new Map<string, string[]>()
    for (const row of rows) {
      const cols = map.get(row.constraint_name) ?? []
      cols.push(row.column_name)
      map.set(row.constraint_name, cols)
    }

    return Array.from(map.values()).map(columns => ({ columns }))
  }

  // --- Indexes ---

  private async loadIndexes(table: string): Promise<IndexDefinition[]> {
    const rows = await this.db.sql`
      SELECT
        i.relname AS index_name,
        a.attname AS column_name,
        ix.indisunique AS is_unique,
        ix.indisprimary AS is_primary
      FROM pg_index ix
      JOIN pg_class t ON t.oid = ix.indrelid
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = ANY(ix.indkey)
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = 'public'
        AND t.relname = ${table}
        AND NOT ix.indisprimary
      ORDER BY i.relname, a.attnum
    `

    const map = new Map<string, { columns: string[]; unique: boolean }>()
    for (const row of rows) {
      const key = row.index_name
      if (!map.has(key)) {
        map.set(key, { columns: [], unique: row.is_unique })
      }
      map.get(key)!.columns.push(row.column_name)
    }

    return Array.from(map.values())
  }

  // --- Helpers ---

  private mapPgType(udtName: string, dataType: string, enumNames: Set<string>): PostgreSQLType {
    // Check if it's a known enum
    if (enumNames.has(udtName)) {
      return { type: 'custom', name: udtName } satisfies PostgreSQLCustomType
    }

    return PG_TYPE_MAP[udtName] ?? (udtName as PostgreSQLType)
  }

  private parseDefault(
    columnDefault: string | null,
    pgType: PostgreSQLType
  ): DefaultValue | undefined {
    if (columnDefault === null || columnDefault === undefined) return undefined

    const raw = columnDefault

    // SQL expressions: gen_random_uuid(), CURRENT_TIMESTAMP, now(), nextval(...)
    if (
      raw.startsWith('gen_random_uuid()') ||
      raw === 'CURRENT_TIMESTAMP' ||
      raw.startsWith('now()') ||
      raw.startsWith('nextval(')
    ) {
      return { kind: 'expression', sql: raw }
    }

    // Boolean literals
    if (raw === 'true') return { kind: 'literal', value: true }
    if (raw === 'false') return { kind: 'literal', value: false }

    // NULL
    if (raw === 'NULL' || raw === 'NULL::' + (typeof pgType === 'string' ? pgType : '')) {
      return { kind: 'literal', value: null }
    }

    // Numeric literals
    const pgTypeStr = typeof pgType === 'string' ? pgType : null
    if (pgTypeStr && isNumericType(pgTypeStr)) {
      const num = Number(raw)
      if (!isNaN(num)) return { kind: 'literal', value: num }
    }

    // String literals: 'value'::type or 'value'
    const stringMatch = raw.match(/^'(.*?)'(?:::.*)?$/)
    if (stringMatch) {
      return { kind: 'literal', value: stringMatch[1]! }
    }

    // Fallback: treat as expression
    return { kind: 'expression', sql: raw }
  }

  private normalizeRule(rule: string): 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION' {
    switch (rule) {
      case 'CASCADE':
        return 'CASCADE'
      case 'SET NULL':
        return 'SET NULL'
      case 'RESTRICT':
        return 'RESTRICT'
      default:
        return 'NO ACTION'
    }
  }
}

function isNumericType(pgType: string): boolean {
  return [
    'smallint',
    'integer',
    'bigint',
    'real',
    'double_precision',
    'decimal',
    'numeric',
    'money',
  ].includes(pgType)
}
