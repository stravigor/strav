import { Archetype } from './types'
import type { SchemaInput, SchemaDefinition } from './types'
import type { FieldDefinition } from './field_definition'
import type { PostgreSQLCustomType } from './postgres'

/**
 * Define a data schema for the application.
 *
 * Resolves all {@link FieldBuilder} instances into {@link FieldDefinition}s,
 * assigns proper enum names, and returns a {@link SchemaDefinition}.
 *
 * @example
 * export default defineSchema('user', {
 *   archetype: Archetype.Entity,
 *   fields: {
 *     email: t.varchar().email().unique().required(),
 *     role:  t.enum(['user', 'admin']).default('user'),
 *   },
 * })
 */
export default function defineSchema(name: string, input: SchemaInput): SchemaDefinition {
  const fields: Record<string, FieldDefinition> = {}

  for (const [fieldName, builder] of Object.entries(input.fields)) {
    const def = builder.toDefinition()

    if (isCustomType(def.pgType) && def.pgType.values?.length) {
      def.pgType = { ...def.pgType, name: `${name}_${fieldName}` }
    }

    fields[fieldName] = def
  }

  return {
    name,
    archetype: input.archetype ?? Archetype.Entity,
    parents: input.parents,
    associates: input.associates,
    as: input.as,
    tenanted: input.tenanted ?? false,
    fields,
  }
}

function isCustomType(pgType: unknown): pgType is PostgreSQLCustomType {
  return typeof pgType === 'object' && pgType !== null && (pgType as any).type === 'custom'
}
