import { Archetype } from './types'
import type { SchemaInput, SchemaDefinition } from './types'
import type { FieldDefinition } from './field_definition'
import type { PostgreSQLCustomType } from './postgres'
import { isTenantedSequence } from './naming'

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

  validateTenantedSequenceFields(name, fields, input.tenanted ?? false)
  if (input.tenantRegistry) validateTenantRegistryFields(name, fields)

  return {
    name,
    archetype: input.archetype ?? Archetype.Entity,
    parents: input.parents,
    associates: input.associates,
    as: input.as,
    tenanted: input.tenanted ?? false,
    tenantRegistry: input.tenantRegistry ?? false,
    fields,
  }
}

/**
 * The tenant registry table must have a single primary key of an
 * auto-numbering integer type (`serial` / `bigserial` / `smallserial`) or a
 * `uuid`. The framework reads this PK to derive the FK column type on every
 * tenanted child and the cast used in RLS policy expressions.
 */
function validateTenantRegistryFields(
  schemaName: string,
  fields: Record<string, FieldDefinition>
): void {
  const pkFields = Object.entries(fields).filter(([, def]) => def.primaryKey)
  if (pkFields.length !== 1) {
    throw new Error(
      `Tenant registry schema "${schemaName}" must declare exactly one primary key field (got ${pkFields.length}).`
    )
  }
  const [, pkField] = pkFields[0]!
  const allowed = new Set([
    'serial',
    'bigserial',
    'smallserial',
    'uuid',
  ])
  if (typeof pkField.pgType !== 'string' || !allowed.has(pkField.pgType)) {
    throw new Error(
      `Tenant registry schema "${schemaName}" PK must be t.serial(), t.bigserial(), t.smallserial(), or t.uuid() (got ${JSON.stringify(pkField.pgType)}).`
    )
  }
}

/**
 * Validate that `t.tenantedSerial()` / `t.tenantedBigSerial()` fields are used
 * correctly: only on tenanted schemas, only as the primary key, and at most
 * one per schema.
 */
function validateTenantedSequenceFields(
  schemaName: string,
  fields: Record<string, FieldDefinition>,
  tenanted: boolean
): void {
  const tenantedSeqFields = Object.entries(fields).filter(([, def]) =>
    isTenantedSequence(def.pgType)
  )
  if (tenantedSeqFields.length === 0) return

  if (!tenanted) {
    throw new Error(
      `Schema "${schemaName}": t.tenantedSerial() / t.tenantedBigSerial() requires { tenanted: true } on the schema.`
    )
  }
  if (tenantedSeqFields.length > 1) {
    throw new Error(
      `Schema "${schemaName}": only one tenantedSerial/tenantedBigSerial field allowed per schema (found ${tenantedSeqFields.length}).`
    )
  }
  const [fieldName, def] = tenantedSeqFields[0]!
  if (!def.primaryKey) {
    throw new Error(
      `Schema "${schemaName}": tenantedSerial field "${fieldName}" must be marked .primaryKey().`
    )
  }
}

function isCustomType(pgType: unknown): pgType is PostgreSQLCustomType {
  return typeof pgType === 'object' && pgType !== null && (pgType as any).type === 'custom'
}
