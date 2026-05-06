import { Archetype } from './types'
import type { SchemaDefinition } from './types'
import type { FieldDefinition } from './field_definition'
import type { PostgreSQLCustomType, PostgreSQLType } from './postgres'
import type {
  DatabaseRepresentation,
  TableDefinition,
  ColumnDefinition,
  EnumDefinition,
  ForeignKeyConstraint,
  PrimaryKeyConstraint,
  UniqueConstraint,
  IndexDefinition,
  DefaultValue,
} from './database_representation'
import { toSnakeCase, serialToIntegerType, isTenantedSequence } from './naming'
import { type TenantIdType, DEFAULT_TENANT_ID_TYPE } from '../database/tenant/id_type'

/** Timestamp columns each archetype receives automatically. */
const TIMESTAMP_RULES: Record<
  Archetype,
  { created_at: boolean; updated_at: boolean; deleted_at: boolean }
> = {
  [Archetype.Entity]: { created_at: true, updated_at: true, deleted_at: true },
  [Archetype.Component]: { created_at: true, updated_at: true, deleted_at: false },
  [Archetype.Attribute]: { created_at: true, updated_at: true, deleted_at: true },
  [Archetype.Association]: { created_at: true, updated_at: true, deleted_at: false },
  [Archetype.Event]: { created_at: true, updated_at: false, deleted_at: false },
  [Archetype.Reference]: { created_at: true, updated_at: true, deleted_at: false },
  [Archetype.Configuration]: { created_at: true, updated_at: true, deleted_at: false },
  [Archetype.Contribution]: { created_at: true, updated_at: true, deleted_at: true },
}

/** Archetypes that have a parent FK (dependent archetypes except association). */
const PARENT_FK_ARCHETYPES: Set<Archetype> = new Set([
  Archetype.Component,
  Archetype.Attribute,
  Archetype.Event,
  Archetype.Configuration,
  Archetype.Contribution,
])

/** Resolved primary key info for a schema. */
interface PKInfo {
  name: string
  pgType: PostgreSQLType
  fieldDef?: FieldDefinition  // Full field definition for preserving column properties
  /**
   * True when the parent's PK is a per-tenant sequence on a tenanted schema.
   * Children referencing such a parent must emit composite FKs
   * `(tenant_id, parent_id) → parent(tenant_id, id)`.
   */
  isTenantedComposite?: boolean
}

/**
 * Transforms a set of {@link SchemaDefinition}s into a {@link DatabaseRepresentation}.
 *
 * Schemas must be provided in dependency order (from {@link SchemaRegistry.resolve}).
 */
export default class RepresentationBuilder {
  private schemas: Map<string, SchemaDefinition>
  private tenantIdType: TenantIdType

  constructor(schemas: SchemaDefinition[], tenantIdType: TenantIdType = DEFAULT_TENANT_ID_TYPE) {
    this.schemas = new Map(schemas.map(s => [s.name, s]))
    this.tenantIdType = tenantIdType
  }

  build(): DatabaseRepresentation {
    const enums = this.collectEnums()
    const tables: TableDefinition[] = []

    for (const schema of this.schemas.values()) {
      tables.push(this.buildTable(schema))
    }

    return { enums, tables }
  }

  private buildTable(schema: SchemaDefinition): TableDefinition {
    const columns: ColumnDefinition[] = []
    const foreignKeys: ForeignKeyConstraint[] = []
    const uniqueConstraints: UniqueConstraint[] = []
    const indexes: IndexDefinition[] = []

    // 1. Primary key
    const pk = this.addPrimaryKey(schema, columns)

    // 1b. Promote a tenanted-sequence PK to composite (tenant_id, id) before
    //     addTenantColumn runs, so it can skip the now-redundant index.
    const pkColumn =
      pk && pk.columns.length === 1 ? columns.find(c => c.name === pk.columns[0]) : null
    if (pk && pkColumn?.tenantedSequence && schema.tenanted) {
      pk.columns = ['tenant_id', ...pk.columns]
    }

    // 2. Tenant column (tenant-scoped tables only) — must come before
    //    other FK/parent columns so it appears near the top of the table.
    if (schema.tenanted) {
      this.addTenantColumn(columns, foreignKeys, indexes, pk)
    }

    // 3. Parent FK (for dependent archetypes)
    this.addParentFK(schema, columns, foreignKeys, indexes)

    // 4. Association FKs
    this.addAssociationFKs(schema, columns, foreignKeys, uniqueConstraints, indexes)

    // 5. User-defined fields (non-reference fields)
    // 6. Reference fields resolved to FK columns
    this.addUserFields(schema, columns, foreignKeys, indexes)

    // 7. Timestamps
    this.addTimestamps(schema, columns)

    // 8. NOT NULL defaults (skip FK columns — they must never have defaults)
    this.applyNotNullDefaults(columns, foreignKeys)

    return {
      name: toSnakeCase(schema.name),
      archetype: schema.archetype,
      tenanted: schema.tenanted ?? false,
      columns,
      primaryKey: pk,
      foreignKeys,
      uniqueConstraints,
      indexes,
    }
  }

  /**
   * Inject the `tenant_id` column for tenant-scoped tables.
   *
   * The column is NOT NULL with a DEFAULT of
   * `current_setting('app.tenant_id', true)::<idType>`, which the application
   * populates inside a `withTenant(...)` block. Falls back to FK CASCADE on
   * `tenant(id)` so deleting a tenant cleans up rows.
   *
   * The matching RLS policy DDL is emitted by the SQL generator.
   */
  private addTenantColumn(
    columns: ColumnDefinition[],
    foreignKeys: ForeignKeyConstraint[],
    indexes: IndexDefinition[],
    pk: PrimaryKeyConstraint | null
  ): void {
    const pgType: PostgreSQLType = this.tenantIdType === 'uuid' ? 'uuid' : 'bigint'
    columns.push({
      name: 'tenant_id',
      pgType,
      notNull: true,
      defaultValue: {
        kind: 'expression',
        sql: `current_setting('app.tenant_id', true)::${this.tenantIdType}`,
      },
      unique: false,
      primaryKey: false,
      autoIncrement: false,
      index: true,
      sensitive: false,
      isArray: false,
      arrayDimensions: 1,
    })

    foreignKeys.push({
      columns: ['tenant_id'],
      referencedTable: 'tenant',
      referencedColumns: ['id'],
      onDelete: 'CASCADE',
      onUpdate: 'CASCADE',
    })

    // Composite index aligned with RLS predicate (tenant_id, pk).
    // Skip when the PK already starts with tenant_id (tenanted-sequence
    // promotion) — Postgres auto-indexes the PK.
    if (pk && pk.columns.length > 0) {
      if (pk.columns[0] !== 'tenant_id') {
        indexes.push({ columns: ['tenant_id', ...pk.columns], unique: false })
      }
    } else {
      indexes.push({ columns: ['tenant_id'], unique: false })
    }
  }

  /**
   * Add the primary key column. Returns the PK constraint or null for associations.
   */
  private addPrimaryKey(
    schema: SchemaDefinition,
    columns: ColumnDefinition[]
  ): PrimaryKeyConstraint | null {
    if (schema.archetype === Archetype.Association) return null

    // Check if developer specified a PK
    for (const [fieldName, fieldDef] of Object.entries(schema.fields)) {
      if (fieldDef.primaryKey) {
        const colName = toSnakeCase(fieldName)
        if (isTenantedSequence(fieldDef.pgType)) {
          // Per-tenant sequence: store as INTEGER/BIGINT, populated by the
          // strav_assign_tenanted_id() BEFORE INSERT trigger. No SERIAL,
          // no DEFAULT. Composite-PK promotion happens in buildTable.
          columns.push({
            name: colName,
            pgType: serialToIntegerType(fieldDef.pgType),
            notNull: true,
            unique: false,
            primaryKey: true,
            autoIncrement: false,
            index: false,
            sensitive: false,
            isArray: false,
            arrayDimensions: 1,
            tenantedSequence: true,
          })
          return { columns: [colName] }
        }
        columns.push(this.fieldToColumn(colName, fieldDef))
        return { columns: [colName] }
      }
    }

    // Auto-add default: id serial
    columns.push({
      name: 'id',
      pgType: 'serial',
      notNull: true,
      unique: true,
      primaryKey: true,
      autoIncrement: true,
      index: false,
      sensitive: false,
      isArray: false,
      arrayDimensions: 1,
    })

    return { columns: ['id'] }
  }

  /**
   * Add parent FK columns for dependent archetypes.
   */
  private addParentFK(
    schema: SchemaDefinition,
    columns: ColumnDefinition[],
    foreignKeys: ForeignKeyConstraint[],
    indexes: IndexDefinition[]
  ): void {
    if (!schema.parents?.length || !PARENT_FK_ARCHETYPES.has(schema.archetype)) return

    for (const parentName of schema.parents) {
      const parentSchema = this.schemas.get(parentName)
      if (!parentSchema) continue

      const parentPK = this.findPrimaryKey(parentSchema)
      const fkColName = `${toSnakeCase(parentName)}_${toSnakeCase(parentPK.name)}`
      const fkColType = serialToIntegerType(parentPK.pgType)

      columns.push({
        name: fkColName,
        pgType: fkColType,
        notNull: true,
        unique: false,
        primaryKey: false,
        autoIncrement: false,
        index: true,
        sensitive: false,
        isArray: false,
        arrayDimensions: 1,
        length: parentPK.fieldDef?.length,
        precision: parentPK.fieldDef?.precision,
        scale: parentPK.fieldDef?.scale,
        isUlid: parentPK.fieldDef?.isUlid,
      })

      if (parentPK.isTenantedComposite) {
        this.assertTenantedChild(schema, parentName, 'parent')
        foreignKeys.push({
          columns: ['tenant_id', fkColName],
          referencedTable: toSnakeCase(parentName),
          referencedColumns: ['tenant_id', toSnakeCase(parentPK.name)],
          onDelete: 'CASCADE',
          onUpdate: 'CASCADE',
        })
        indexes.push({ columns: ['tenant_id', fkColName], unique: false })
      } else {
        foreignKeys.push({
          columns: [fkColName],
          referencedTable: toSnakeCase(parentName),
          referencedColumns: [toSnakeCase(parentPK.name)],
          onDelete: 'CASCADE',
          onUpdate: 'CASCADE',
        })
        indexes.push({ columns: [fkColName], unique: false })
      }
    }
  }

  /**
   * Throw if a schema references a tenanted-sequence parent/entity but is not
   * itself tenanted. The composite FK requires a `tenant_id` column on the child.
   */
  private assertTenantedChild(
    schema: SchemaDefinition,
    refName: string,
    kind: 'parent' | 'entity' | 'reference'
  ): void {
    if (!schema.tenanted) {
      throw new Error(
        `Schema "${schema.name}" references ${kind} "${refName}" which has a tenantedSerial primary key, but "${schema.name}" is not marked tenanted: true. Composite foreign keys require a tenant_id column on the child.`
      )
    }
  }

  /**
   * Add FK columns for both sides of an association.
   */
  private addAssociationFKs(
    schema: SchemaDefinition,
    columns: ColumnDefinition[],
    foreignKeys: ForeignKeyConstraint[],
    uniqueConstraints: UniqueConstraint[],
    indexes: IndexDefinition[]
  ): void {
    if (schema.archetype !== Archetype.Association || !schema.associates) return

    const fkColNames: string[] = []
    let anyComposite = false

    for (const entityName of schema.associates) {
      const entitySchema = this.schemas.get(entityName)
      if (!entitySchema) continue

      const entityPK = this.findPrimaryKey(entitySchema)
      const fkColName = `${toSnakeCase(entityName)}_${toSnakeCase(entityPK.name)}`
      const fkColType = serialToIntegerType(entityPK.pgType)

      fkColNames.push(fkColName)

      columns.push({
        name: fkColName,
        pgType: fkColType,
        notNull: true,
        unique: false,
        primaryKey: false,
        autoIncrement: false,
        index: true,
        sensitive: false,
        isArray: false,
        arrayDimensions: 1,
        length: entityPK.fieldDef?.length,
        precision: entityPK.fieldDef?.precision,
        scale: entityPK.fieldDef?.scale,
        isUlid: entityPK.fieldDef?.isUlid,
      })

      if (entityPK.isTenantedComposite) {
        anyComposite = true
        this.assertTenantedChild(schema, entityName, 'entity')
        foreignKeys.push({
          columns: ['tenant_id', fkColName],
          referencedTable: toSnakeCase(entityName),
          referencedColumns: ['tenant_id', toSnakeCase(entityPK.name)],
          onDelete: 'CASCADE',
          onUpdate: 'CASCADE',
        })
        indexes.push({ columns: ['tenant_id', fkColName], unique: false })
      } else {
        foreignKeys.push({
          columns: [fkColName],
          referencedTable: toSnakeCase(entityName),
          referencedColumns: [toSnakeCase(entityPK.name)],
          onDelete: 'CASCADE',
          onUpdate: 'CASCADE',
        })
        indexes.push({ columns: [fkColName], unique: false })
      }
    }

    // Composite unique on the FK pair (also add the backing index PostgreSQL creates).
    // When any side is a tenanted-composite parent, scope uniqueness by tenant.
    if (fkColNames.length === 2) {
      const uqCols = anyComposite ? ['tenant_id', ...fkColNames] : fkColNames
      uniqueConstraints.push({ columns: uqCols })
      indexes.push({ columns: uqCols, unique: true })
    }
  }

  /**
   * Add user-defined fields. Reference fields are resolved to proper FK columns.
   */
  private addUserFields(
    schema: SchemaDefinition,
    columns: ColumnDefinition[],
    foreignKeys: ForeignKeyConstraint[],
    indexes: IndexDefinition[]
  ): void {
    const associateSet = new Set(schema.associates ?? [])

    for (const [fieldName, fieldDef] of Object.entries(schema.fields)) {
      // Skip PK fields — already handled
      if (fieldDef.primaryKey) continue

      if (fieldDef.references) {
        // Skip reference fields that duplicate an association FK
        if (associateSet.has(fieldDef.references)) continue

        this.addReferenceColumn(fieldName, fieldDef, columns, foreignKeys, indexes)
      } else {
        columns.push(this.fieldToColumn(toSnakeCase(fieldName), fieldDef))

        if (fieldDef.index) {
          indexes.push({ columns: [toSnakeCase(fieldName)], unique: false })
        }
        if (fieldDef.unique) {
          indexes.push({ columns: [toSnakeCase(fieldName)], unique: true })
        }
      }
    }
  }

  /**
   * Resolve a reference field into a proper FK column.
   */
  private addReferenceColumn(
    fieldName: string,
    fieldDef: FieldDefinition,
    columns: ColumnDefinition[],
    foreignKeys: ForeignKeyConstraint[],
    indexes: IndexDefinition[]
  ): void {
    const refSchema = this.schemas.get(fieldDef.references!)
    if (!refSchema) return

    const refPK = this.findPrimaryKey(refSchema)
    const fkColName = `${toSnakeCase(fieldName)}_${toSnakeCase(refPK.name)}`
    const fkColType = serialToIntegerType(refPK.pgType)

    columns.push({
      name: fkColName,
      pgType: fkColType,
      notNull: fieldDef.required,
      unique: fieldDef.unique,
      primaryKey: false,
      autoIncrement: false,
      index: true,
      sensitive: fieldDef.sensitive,
      isArray: false,
      arrayDimensions: 1,
      length: refPK.fieldDef?.length,
      precision: refPK.fieldDef?.precision,
      scale: refPK.fieldDef?.scale,
      isUlid: refPK.fieldDef?.isUlid,
    })

    if (refPK.isTenantedComposite) {
      // We need a child schema reference to validate, but addReferenceColumn
      // doesn't currently receive it. Validate here against refSchema; the
      // child is the schema currently being built, not refSchema. Look up via
      // foreignKeys path by checking ['tenant_id'] presence in `columns`.
      const childHasTenantId = columns.some(c => c.name === 'tenant_id')
      if (!childHasTenantId) {
        throw new Error(
          `Reference field "${fieldName}" targets tenanted-sequence schema "${fieldDef.references}", but the referencing schema is not tenanted. Composite foreign keys require a tenant_id column on the child.`
        )
      }
      foreignKeys.push({
        columns: ['tenant_id', fkColName],
        referencedTable: toSnakeCase(fieldDef.references!),
        referencedColumns: ['tenant_id', toSnakeCase(refPK.name)],
        // Composite FKs must use CASCADE: SET NULL is impossible because
        // tenant_id is NOT NULL.
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      })
      indexes.push({ columns: ['tenant_id', fkColName], unique: false })
    } else {
      foreignKeys.push({
        columns: [fkColName],
        referencedTable: toSnakeCase(fieldDef.references!),
        referencedColumns: [toSnakeCase(refPK.name)],
        onDelete: fieldDef.required ? 'RESTRICT' : 'SET NULL',
        onUpdate: 'CASCADE',
      })
      indexes.push({ columns: [fkColName], unique: false })
    }
  }

  /**
   * Add timestamp columns per archetype rules, skipping any already present.
   */
  private addTimestamps(schema: SchemaDefinition, columns: ColumnDefinition[]): void {
    const rules = TIMESTAMP_RULES[schema.archetype]
    if (!rules) return

    const existing = new Set(columns.map(c => c.name))

    if (rules.created_at && !existing.has('created_at')) {
      columns.push(this.makeTimestampColumn('created_at', true))
    }
    if (rules.updated_at && !existing.has('updated_at')) {
      columns.push(this.makeTimestampColumn('updated_at', true))
    }
    if (rules.deleted_at && !existing.has('deleted_at')) {
      columns.push(this.makeTimestampColumn('deleted_at', false))
    }
  }

  /**
   * Assign default values to NOT NULL columns that lack one.
   * FK columns are excluded — they must never receive automatic defaults.
   */
  private applyNotNullDefaults(
    columns: ColumnDefinition[],
    foreignKeys: ForeignKeyConstraint[]
  ): void {
    const fkColumns = new Set(foreignKeys.flatMap(fk => fk.columns))

    for (const col of columns) {
      if (!col.notNull) continue
      if (col.defaultValue !== undefined) continue
      if (col.autoIncrement) continue
      if (fkColumns.has(col.name)) continue

      const pgType = typeof col.pgType === 'string' ? col.pgType : null
      if (!pgType) continue

      const def = this.inferDefault(pgType)
      if (def) col.defaultValue = def
    }
  }

  /**
   * Infer a sensible default for a given PostgreSQL type.
   */
  private inferDefault(pgType: string): DefaultValue | undefined {
    switch (pgType) {
      case 'uuid':
        return { kind: 'expression', sql: 'gen_random_uuid()' }
      case 'timestamp':
      case 'timestamptz':
        return { kind: 'expression', sql: 'CURRENT_TIMESTAMP' }
      case 'boolean':
        return { kind: 'literal', value: false }
      case 'smallint':
      case 'integer':
      case 'bigint':
      case 'real':
      case 'double_precision':
      case 'decimal':
      case 'numeric':
      case 'money':
        return { kind: 'literal', value: 0 }
      case 'varchar':
      case 'character_varying':
      case 'char':
      case 'character':
      case 'text':
        return { kind: 'literal', value: '' }
      case 'json':
      case 'jsonb':
        return { kind: 'literal', value: '{}' }
      default:
        return undefined
    }
  }

  // --- Helpers ---

  /**
   * Find the primary key of a schema. Falls back to the auto-generated default.
   */
  private findPrimaryKey(schema: SchemaDefinition): PKInfo {
    for (const [fieldName, fieldDef] of Object.entries(schema.fields)) {
      if (fieldDef.primaryKey) {
        const isTenantedComposite = !!schema.tenanted && isTenantedSequence(fieldDef.pgType)
        return { name: fieldName, pgType: fieldDef.pgType, fieldDef, isTenantedComposite }
      }
    }
    return { name: 'id', pgType: 'serial' }
  }

  /**
   * Convert a FieldDefinition to a ColumnDefinition.
   */
  private fieldToColumn(name: string, fieldDef: FieldDefinition): ColumnDefinition {
    return {
      name,
      pgType: fieldDef.pgType,
      notNull: fieldDef.required || fieldDef.primaryKey,
      defaultValue:
        fieldDef.defaultValue !== undefined
          ? { kind: 'literal', value: fieldDef.defaultValue as string | number | boolean | null }
          : undefined,
      unique: fieldDef.unique,
      primaryKey: fieldDef.primaryKey,
      autoIncrement: isSerial(fieldDef.pgType),
      index: fieldDef.index,
      sensitive: fieldDef.sensitive,
      isArray: fieldDef.isArray,
      arrayDimensions: fieldDef.arrayDimensions,
      length: fieldDef.length,
      precision: fieldDef.precision,
      scale: fieldDef.scale,
      isUlid: fieldDef.isUlid,
    }
  }

  /**
   * Create a timestamp column definition.
   */
  private makeTimestampColumn(name: string, notNull: boolean): ColumnDefinition {
    return {
      name,
      pgType: 'timestamptz',
      notNull,
      defaultValue: notNull ? { kind: 'expression', sql: 'CURRENT_TIMESTAMP' } : undefined,
      unique: false,
      primaryKey: false,
      autoIncrement: false,
      index: false,
      sensitive: false,
      isArray: false,
      arrayDimensions: 1,
    }
  }

  /**
   * Collect all enum definitions from all schemas, deduped by name.
   */
  private collectEnums(): EnumDefinition[] {
    const enums: EnumDefinition[] = []
    const seen = new Set<string>()

    for (const schema of this.schemas.values()) {
      for (const fieldDef of Object.values(schema.fields)) {
        if (isCustomType(fieldDef.pgType) && fieldDef.pgType.values?.length) {
          const enumName = fieldDef.pgType.name
          if (enumName && !seen.has(enumName)) {
            seen.add(enumName)
            enums.push({ name: enumName, values: fieldDef.pgType.values })
          }
        }
      }
    }

    return enums
  }
}

function isCustomType(pgType: unknown): pgType is PostgreSQLCustomType {
  return typeof pgType === 'object' && pgType !== null && (pgType as any).type === 'custom'
}

function isSerial(pgType: PostgreSQLType): boolean {
  return pgType === 'serial' || pgType === 'bigserial' || pgType === 'smallserial'
}
