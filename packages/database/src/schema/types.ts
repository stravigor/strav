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

/** The input shape that users pass to {@link defineSchema}. */
export interface SchemaInput {
  archetype?: Archetype
  parents?: string[]
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
}

/** The resolved schema stored in the registry. */
export interface SchemaDefinition {
  name: string
  archetype: Archetype
  parents?: string[]
  associates?: string[]
  as?: Record<string, string>
  /** Whether this table is tenant-scoped (carries the tenant FK + RLS). */
  tenanted?: boolean
  /** Whether this is the tenant registry schema (see {@link SchemaInput.tenantRegistry}). */
  tenantRegistry?: boolean
  fields: Record<string, FieldDefinition>
}
