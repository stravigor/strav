import type { PostgreSQLType } from './postgres'
import type { Archetype } from './types'

/**
 * Represents the full database schema derived from all registered SchemaDefinitions.
 * Contains all enum types and table definitions in dependency order.
 */
export interface DatabaseRepresentation {
  /** PostgreSQL enum types that must be created before tables. */
  enums: EnumDefinition[]
  /** Table definitions in dependency order. */
  tables: TableDefinition[]
}

/**
 * A PostgreSQL CREATE TYPE ... AS ENUM definition.
 */
export interface EnumDefinition {
  /** Enum type name (e.g. 'order_status'). */
  name: string
  /** Allowed values. */
  values: string[]
}

/**
 * A PostgreSQL table definition.
 */
export interface TableDefinition {
  /** Table name in snake_case, not pluralized. */
  name: string
  /** The archetype this table was derived from (absent when introspected from DB). */
  archetype?: Archetype
  /** Whether this table is tenant-scoped (carries `tenant_id` + RLS policy). */
  tenanted?: boolean
  /** Ordered list of columns. */
  columns: ColumnDefinition[]
  /** Primary key constraint, or null for associations. */
  primaryKey: PrimaryKeyConstraint | null
  /** Foreign key constraints. */
  foreignKeys: ForeignKeyConstraint[]
  /** Unique constraints (beyond individual column UNIQUE). */
  uniqueConstraints: UniqueConstraint[]
  /** Index definitions. */
  indexes: IndexDefinition[]
}

/**
 * A single column in a table.
 */
export interface ColumnDefinition {
  /** Column name in snake_case. */
  name: string
  /** PostgreSQL column type. */
  pgType: PostgreSQLType
  /** Whether the column is NOT NULL. */
  notNull: boolean
  /** Default value (literal or SQL expression). */
  defaultValue?: DefaultValue
  /** Whether the column has a UNIQUE constraint. */
  unique: boolean
  /** Whether the column is part of the primary key. */
  primaryKey: boolean
  /** Whether the column is auto-incrementing (serial). */
  autoIncrement: boolean
  /** Whether the column should be indexed. */
  index: boolean
  /** Whether the column contains sensitive data (app-level, absent when introspected). */
  sensitive?: boolean
  /** Whether this is an array column. */
  isArray: boolean
  /** Array dimensions. */
  arrayDimensions: number
  /** Max length for varchar/char. */
  length?: number
  /** Precision for decimal/numeric. */
  precision?: number
  /** Scale for decimal/numeric. */
  scale?: number
  /** Whether this field is a ULID (stored as char(26)). */
  isUlid?: boolean
}

/**
 * A default value for a column — either a literal value or a SQL expression.
 */
export type DefaultValue =
  | { kind: 'literal'; value: string | number | boolean | null }
  | { kind: 'expression'; sql: string }

/**
 * A primary key constraint (single or composite).
 */
export interface PrimaryKeyConstraint {
  columns: string[]
}

/**
 * A foreign key constraint.
 */
export interface ForeignKeyConstraint {
  /** Column(s) in this table. */
  columns: string[]
  /** Referenced table. */
  referencedTable: string
  /** Referenced column(s). */
  referencedColumns: string[]
  /** ON DELETE behavior. */
  onDelete: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION'
  /** ON UPDATE behavior. */
  onUpdate: 'CASCADE' | 'SET NULL' | 'RESTRICT' | 'NO ACTION'
}

/**
 * A unique constraint across one or more columns.
 */
export interface UniqueConstraint {
  columns: string[]
}

/**
 * An index definition.
 */
export interface IndexDefinition {
  columns: string[]
  unique: boolean
}
