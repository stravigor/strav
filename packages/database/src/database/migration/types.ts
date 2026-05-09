import type {
  ColumnDefinition,
  ForeignKeyConstraint,
  UniqueConstraint,
  IndexDefinition,
  TableDefinition,
} from '../../schema/database_representation'
import type { PostgreSQLType } from '../../schema/postgres'

// ---------------------------------------------------------------------------
// Extension diffs
// ---------------------------------------------------------------------------

export interface ExtensionCreate {
  kind: 'create'
  name: string
}

export interface ExtensionDrop {
  kind: 'drop'
  name: string
}

export type ExtensionDiff = ExtensionCreate | ExtensionDrop

// ---------------------------------------------------------------------------
// Enum diffs
// ---------------------------------------------------------------------------

export interface EnumCreate {
  kind: 'create'
  name: string
  values: string[]
}

export interface EnumDrop {
  kind: 'drop'
  name: string
  values: string[]
}

export interface EnumModify {
  kind: 'modify'
  name: string
  addedValues: string[]
}

export type EnumDiff = EnumCreate | EnumDrop | EnumModify

// ---------------------------------------------------------------------------
// Column diffs
// ---------------------------------------------------------------------------

export interface ColumnAdd {
  kind: 'add'
  column: ColumnDefinition
}

export interface ColumnDrop {
  kind: 'drop'
  column: ColumnDefinition
}

export interface ColumnAlter {
  kind: 'alter'
  columnName: string
  typeChange?: { from: PostgreSQLType; to: PostgreSQLType }
  nullableChange?: { from: boolean; to: boolean }
  defaultChange?: {
    from: ColumnDefinition['defaultValue']
    to: ColumnDefinition['defaultValue']
  }
}

export type ColumnDiff = ColumnAdd | ColumnDrop | ColumnAlter

// ---------------------------------------------------------------------------
// Table diffs
// ---------------------------------------------------------------------------

export interface TableCreate {
  kind: 'create'
  table: TableDefinition
}

export interface TableDrop {
  kind: 'drop'
  table: TableDefinition
}

export interface TableModify {
  kind: 'modify'
  tableName: string
  columns: ColumnDiff[]
}

export type TableDiff = TableCreate | TableDrop | TableModify

// ---------------------------------------------------------------------------
// Constraint diffs
// ---------------------------------------------------------------------------

export interface ForeignKeyAdd {
  kind: 'add_fk'
  tableName: string
  constraint: ForeignKeyConstraint
}

export interface ForeignKeyDrop {
  kind: 'drop_fk'
  tableName: string
  constraint: ForeignKeyConstraint
}

export interface UniqueAdd {
  kind: 'add_unique'
  tableName: string
  constraint: UniqueConstraint
}

export interface UniqueDrop {
  kind: 'drop_unique'
  tableName: string
  constraint: UniqueConstraint
}

export type ConstraintDiff = ForeignKeyAdd | ForeignKeyDrop | UniqueAdd | UniqueDrop

// ---------------------------------------------------------------------------
// Index diffs
// ---------------------------------------------------------------------------

export interface IndexAdd {
  kind: 'add'
  tableName: string
  index: IndexDefinition
}

export interface IndexDrop {
  kind: 'drop'
  tableName: string
  index: IndexDefinition
}

export type IndexDiff = IndexAdd | IndexDrop

// ---------------------------------------------------------------------------
// Top-level schema diff
// ---------------------------------------------------------------------------

export interface SchemaDiff {
  extensions: ExtensionDiff[]
  enums: EnumDiff[]
  tables: TableDiff[]
  constraints: ConstraintDiff[]
  indexes: IndexDiff[]
}

// ---------------------------------------------------------------------------
// Generated SQL output
// ---------------------------------------------------------------------------

export interface GeneratedSql {
  extensionsUp: string
  extensionsDown: string
  enumsUp: string
  enumsDown: string
  tables: Map<string, { up: string; down: string }>
  constraintsUp: string
  constraintsDown: string
  indexesUp: string
  indexesDown: string
}

// ---------------------------------------------------------------------------
// Migration manifest (stored as manifest.json)
// ---------------------------------------------------------------------------

export interface MigrationSummary {
  tablesToCreate: number
  tablesToDrop: number
  tablesToModify: number
  enumsToCreate: number
  enumsToModify: number
  enumsToDrop: number
  extensionsToCreate: number
  extensionsToDrop: number
}

export interface MigrationManifest {
  version: string
  message: string
  generatedAt: string
  summary: MigrationSummary
  executionOrder: {
    up: string[]
    down: string[]
  }
}

// ---------------------------------------------------------------------------
// Migration tracking record (from _strav_migrations table)
// ---------------------------------------------------------------------------

export interface MigrationRecord {
  id: number
  version: string
  batch: number
  executed_at: Date
}
