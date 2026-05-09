/**
 * Schema DSL Types - Complete PostgreSQL type support
 */
import type { FieldDefinition } from './field_definition'
import type FieldBuilder from './field_builder'

export enum Archetype {
  Entity = 'entity',
  Component = 'component',
  Attribute = 'attribute',
  Association = 'association',
  Event = 'event',
  Reference = 'reference',
  Configuration = 'configuration',
  Contribution = 'contribution',
}

/**
 * Reference to a parent schema in {@link SchemaInput.parents}.
 *
 * Plain string is the parent name. The object form attaches per-parent
 * options — currently only `unique`, which marks the auto-generated FK
 * column as `UNIQUE` (useful for 1:1 components like a single TOTP secret
 * per user).
 */
export type ParentRef = string | { name: string; unique?: boolean }

/** The input shape that users pass to {@link defineSchema}. */
export interface SchemaInput {
  archetype?: Archetype
  parents?: ParentRef[]
  associates?: string[]
  as?: Record<string, string>
  /**
   * Mark the table as tenant-scoped. The schema builder injects a tenant FK
   * column referencing the tenant table and the migration generator emits
   * RLS policy DDL so PostgreSQL enforces isolation by `app.tenant_id`.
   */
  tenanted?: boolean
  /**
   * Mark this schema as the **tenant registry** — the table that holds one
   * row per tenant. The framework reads its name (used as the FK target on
   * tenanted children) and its primary key type (used for the FK column
   * cast and the runtime tenant id validator). At most one schema per
   * registry may set this.
   */
  tenantRegistry?: boolean
  fields: Record<string, FieldBuilder>
  /**
   * Multi-column UNIQUE constraints declared at the schema level.
   *
   * Each entry is a list of logical column names. Each name is resolved as:
   * 1. a parent name from {@link parents} → the FK column it generates,
   * 2. a field name from {@link fields} (snake_cased; reference fields expand to their FK column),
   * 3. an already-emitted column name (e.g. `tenant_id`, timestamps).
   *
   * Single-column entries become a unique index; multi-column entries become a UNIQUE constraint.
   */
  uniques?: string[][]
}

/** The resolved schema stored in the registry. */
export interface SchemaDefinition {
  name: string
  archetype: Archetype
  /** Canonical parent names. Per-parent options are stored separately. */
  parents?: string[]
  /** Names of parents whose generated FK column must be UNIQUE. Subset of {@link parents}. */
  uniqueParents?: string[]
  associates?: string[]
  as?: Record<string, string>
  /** Whether this table is tenant-scoped (carries the tenant FK + RLS). */
  tenanted?: boolean
  /** Whether this is the tenant registry schema (see {@link SchemaInput.tenantRegistry}). */
  tenantRegistry?: boolean
  fields: Record<string, FieldDefinition>
  /** Schema-level UNIQUE declarations — see {@link SchemaInput.uniques}. */
  uniques?: string[][]
}
