import type { PostgreSQLCustomType } from './postgres'
import FieldBuilder from './field_builder'

/**
 * Type builder for schema field definitions.
 *
 * Provides factory methods for every PostgreSQL data type.
 * Each method returns a {@link FieldBuilder} with the correct pgType pre-configured.
 *
 * @example
 * import { t } from '@strav/database/schema'
 * t.varchar(255).email().unique().required()
 * t.integer().default(0)
 * t.jsonb().nullable()
 */
const t = {
  // --- Numeric Types ---
  smallint: () => new FieldBuilder('smallint'),
  integer: () => new FieldBuilder('integer'),
  bigint: () => new FieldBuilder('bigint'),
  decimal: (precision?: number, scale?: number) =>
    new FieldBuilder('decimal', { precision, scale }),
  numeric: (precision?: number, scale?: number) =>
    new FieldBuilder('numeric', { precision, scale }),
  real: () => new FieldBuilder('real'),
  double: () => new FieldBuilder('double_precision'),
  smallserial: () => new FieldBuilder('smallserial'),
  serial: () => new FieldBuilder('serial'),
  bigserial: () => new FieldBuilder('bigserial'),
  /**
   * Per-tenant INTEGER sequence. Each tenant's IDs start at 1 and increment
   * independently (1, 2, 3, ...). Globally unique identity is `(tenant_id, id)`.
   * Requires `tenanted: true` on the schema and must be the primary key.
   */
  tenantedSerial: () => new FieldBuilder('tenanted_serial'),
  /**
   * Per-tenant BIGINT sequence. See {@link tenantedSerial}.
   */
  tenantedBigSerial: () => new FieldBuilder('tenanted_bigserial'),

  // --- Monetary ---
  money: () => new FieldBuilder('money'),

  // --- Character Types ---
  varchar: (length: number = 100) => new FieldBuilder('varchar', { length }),
  /** Alias for {@link varchar}. */
  string: (length: number = 100) => new FieldBuilder('varchar', { length }),
  char: (length?: number) => new FieldBuilder('char', { length }),
  text: () => new FieldBuilder('text'),

  // --- Binary ---
  bytea: () => new FieldBuilder('bytea'),

  // --- Date/Time ---
  timestamp: () => new FieldBuilder('timestamp'),
  timestamptz: () => new FieldBuilder('timestamptz'),
  date: () => new FieldBuilder('date'),
  time: () => new FieldBuilder('time'),
  timetz: () => new FieldBuilder('timetz'),
  interval: () => new FieldBuilder('interval'),

  // --- Boolean ---
  boolean: () => new FieldBuilder('boolean'),

  // --- UUID ---
  uuid: () => new FieldBuilder('uuid'),

  // --- Geometric Types ---
  point: () => new FieldBuilder('point'),
  line: () => new FieldBuilder('line'),
  lseg: () => new FieldBuilder('lseg'),
  box: () => new FieldBuilder('box'),
  path: () => new FieldBuilder('path'),
  polygon: () => new FieldBuilder('polygon'),
  circle: () => new FieldBuilder('circle'),

  // --- Network Address Types ---
  inet: () => new FieldBuilder('inet'),
  cidr: () => new FieldBuilder('cidr'),
  macaddr: () => new FieldBuilder('macaddr'),
  macaddr8: () => new FieldBuilder('macaddr8'),

  // --- Bit String Types ---
  bit: (length?: number) => new FieldBuilder('bit', { length }),
  varbit: (length?: number) => new FieldBuilder('bit_varying', { length }),

  // --- Text Search Types ---
  tsvector: () => new FieldBuilder('tsvector'),
  tsquery: () => new FieldBuilder('tsquery'),

  // --- JSON Types ---
  json: () => new FieldBuilder('json'),
  jsonb: () => new FieldBuilder('jsonb'),

  // --- Range Types ---
  int4range: () => new FieldBuilder('int4range'),
  int8range: () => new FieldBuilder('int8range'),
  numrange: () => new FieldBuilder('numrange'),
  tsrange: () => new FieldBuilder('tsrange'),
  tstzrange: () => new FieldBuilder('tstzrange'),
  daterange: () => new FieldBuilder('daterange'),

  // --- XML ---
  xml: () => new FieldBuilder('xml'),

  // --- Enum ---
  /** Create a PostgreSQL enum type with the given allowed values. */
  enum: (values: string[]) => {
    const customType: PostgreSQLCustomType = { type: 'custom', name: '', values }
    return new FieldBuilder(customType, { enumValues: values })
  },

  /** Foreign key reference to another schema. Column type defaults to UUID. */
  reference: (table: string) => new FieldBuilder('uuid', { references: table }),

  /** ULID (Universally Unique Lexicographically Sortable Identifier) stored as char(26). */
  ulid: () => {
    const builder = new FieldBuilder('char', { length: 26 })
    // Mark this as a ULID type internally
    ;(builder as any)._isUlid = true
    return builder
  },
}

export default t
