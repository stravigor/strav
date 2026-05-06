// Complete PostgreSQL type system
export type PostgreSQLType =
  | PostgreSQLNumericTypes
  | PostgreSQLMonetaryTypes
  | PostgreSQLCharacterTypes
  | PostgreSQLBinaryTypes
  | PostgreSQLDateTimeTypes
  | PostgreSQLBooleanTypes
  | PostgreSQLUUIDTypes
  | PostgreSQLNetworkTypes
  | PostgreSQLBitStringTypes
  | PostgreSQLTextSearchTypes
  | PostgreSQLJSONTypes
  | PostgreSQLGeometricTypes
  | PostgreSQLRangeTypes
  | PostgreSQLXMLTypes
  | PostgreSQLArrayType
  | PostgreSQLCustomType

/** Integer, arbitrary precision, floating-point, and auto-incrementing types. */
export type PostgreSQLNumericTypes =
  | 'smallint'
  | 'integer'
  | 'bigint'
  | 'decimal'
  | 'numeric'
  | 'real'
  | 'double_precision'
  | 'smallserial'
  | 'serial'
  | 'bigserial'
  // Internal markers for per-tenant sequence columns. Not real PostgreSQL types:
  // emitted as INTEGER/BIGINT and assigned via the `strav_assign_tenanted_id()` trigger.
  | 'tenanted_serial'
  | 'tenanted_bigserial'

/** Currency amounts with locale-aware formatting. */
export type PostgreSQLMonetaryTypes = 'money'

/** Fixed-length, variable-length, and unlimited text. */
export type PostgreSQLCharacterTypes =
  | 'character_varying'
  | 'varchar'
  | 'character'
  | 'char'
  | 'text'

/** Raw binary data (byte array). */
export type PostgreSQLBinaryTypes = 'bytea'

/** Dates, times, timestamps, and intervals. */
export type PostgreSQLDateTimeTypes =
  | 'timestamp'
  | 'timestamptz'
  | 'date'
  | 'time'
  | 'timetz'
  | 'interval'

/** True/false logical value. */
export type PostgreSQLBooleanTypes = 'boolean'

/** RFC 4122 universally unique identifiers. */
export type PostgreSQLUUIDTypes = 'uuid'

/** IPv4/IPv6 addresses, CIDR blocks, and MAC addresses. */
export type PostgreSQLNetworkTypes = 'inet' | 'cidr' | 'macaddr' | 'macaddr8'

/** Fixed-length and variable-length bit strings. */
export type PostgreSQLBitStringTypes = 'bit' | 'bit_varying'

/** Full-text search document and query representations. */
export type PostgreSQLTextSearchTypes = 'tsvector' | 'tsquery'

/** JSON data stored as text or decomposed binary. */
export type PostgreSQLJSONTypes = 'json' | 'jsonb'

/** XML document data. */
export type PostgreSQLXMLTypes = 'xml'

/** 2D geometric primitives: points, lines, segments, boxes, paths, polygons, and circles. */
export type PostgreSQLGeometricTypes =
  | 'point'
  | 'line'
  | 'lseg'
  | 'box'
  | 'path'
  | 'polygon'
  | 'circle'

/** Ranges over integer, numeric, timestamp, and date values. */
export type PostgreSQLRangeTypes =
  | 'int4range'
  | 'int8range'
  | 'numrange'
  | 'tsrange'
  | 'tstzrange'
  | 'daterange'

/** Typed multi-dimensional array of any non-array PostgreSQL type. */
export interface PostgreSQLArrayType {
  type: 'array'
  element: Exclude<PostgreSQLType, PostgreSQLArrayType>
  dimensions?: number
}

/** User-defined type, enum, or domain. */
export interface PostgreSQLCustomType {
  type: 'custom'
  name: string // Custom type name or enum name
  definition?: string // For inline enum definitions
  values?: string[] // For enum types - the actual values array
}
