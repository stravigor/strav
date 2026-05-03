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
   * Mark the table as tenant-scoped. The schema builder injects a `tenant_id`
   * UUID column referencing `tenant(id)` and the migration generator emits
   * RLS policy DDL so PostgreSQL enforces isolation by `app.tenant_id`.
   */
  tenanted?: boolean
  fields: Record<string, FieldBuilder>
}

/** The resolved schema stored in the registry. */
export interface SchemaDefinition {
  name: string
  archetype: Archetype
  parents?: string[]
  associates?: string[]
  as?: Record<string, string>
  /** Whether this table is tenant-scoped (carries `tenant_id` + RLS). */
  tenanted?: boolean
  fields: Record<string, FieldDefinition>
}
