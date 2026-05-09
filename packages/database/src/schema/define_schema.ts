import { Archetype } from './types'
import type { ParentRef, SchemaInput, SchemaDefinition } from './types'
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

  const { parents, uniqueParents } = normalizeParents(name, input.parents)
  const uniques = normalizeUniques(name, input.uniques)
  const extensions = normalizeExtensions(name, input.extensions)

  return {
    name,
    archetype: input.archetype ?? Archetype.Entity,
    parents,
    uniqueParents,
    associates: input.associates,
    as: input.as,
    tenanted: input.tenanted ?? false,
    tenantRegistry: input.tenantRegistry ?? false,
    fields,
    uniques,
    extensions,
  }
}

/**
 * Validate {@link SchemaInput.extensions}: drop empty input, reject empty
 * or non-string entries, and dedupe within the schema. Cross-schema dedup
 * happens in {@link RepresentationBuilder}.
 */
function normalizeExtensions(
  schemaName: string,
  extensions: string[] | undefined
): string[] | undefined {
  if (!extensions?.length) return undefined
  const seen = new Set<string>()
  const out: string[] = []
  for (const ext of extensions) {
    if (typeof ext !== 'string' || ext.length === 0) {
      throw new Error(
        `Schema "${schemaName}": extensions entry must be a non-empty string.`
      )
    }
    if (seen.has(ext)) continue
    seen.add(ext)
    out.push(ext)
  }
  return out.length ? out : undefined
}

/**
 * Split {@link ParentRef} entries into canonical names and a separate
 * `uniqueParents` list. Existing consumers of `schema.parents` keep
 * receiving plain strings.
 */
function normalizeParents(
  schemaName: string,
  refs: ParentRef[] | undefined
): { parents?: string[]; uniqueParents?: string[] } {
  if (!refs?.length) return {}
  const names: string[] = []
  const uniqueNames: string[] = []
  const seen = new Set<string>()

  for (const ref of refs) {
    const { name, unique } =
      typeof ref === 'string' ? { name: ref, unique: false } : ref
    if (seen.has(name)) {
      throw new Error(
        `Schema "${schemaName}" lists parent "${name}" more than once.`
      )
    }
    seen.add(name)
    names.push(name)
    if (unique) uniqueNames.push(name)
  }

  return {
    parents: names,
    uniqueParents: uniqueNames.length ? uniqueNames : undefined,
  }
}

/**
 * Validate {@link SchemaInput.uniques}: drop empty / undefined input,
 * reject empty inner arrays, and dedupe entries that name the same column
 * twice. Column-name resolution happens later in the representation builder.
 */
function normalizeUniques(
  schemaName: string,
  uniques: string[][] | undefined
): string[][] | undefined {
  if (!uniques?.length) return undefined
  const out: string[][] = []
  for (const entry of uniques) {
    if (!Array.isArray(entry) || entry.length === 0) {
      throw new Error(
        `Schema "${schemaName}": uniques entry must be a non-empty array of column names.`
      )
    }
    const seen = new Set<string>()
    for (const col of entry) {
      if (typeof col !== 'string' || col.length === 0) {
        throw new Error(
          `Schema "${schemaName}": uniques entry contains a non-string or empty column name.`
        )
      }
      if (seen.has(col)) {
        throw new Error(
          `Schema "${schemaName}": uniques entry [${entry.join(', ')}] names "${col}" more than once.`
        )
      }
      seen.add(col)
    }
    out.push([...entry])
  }
  return out
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
