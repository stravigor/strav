import { join } from 'node:path'
import { Archetype } from '@strav/database/schema/types'
import type { SchemaDefinition } from '@strav/database/schema/types'
import type {
  DatabaseRepresentation,
  TableDefinition,
  ColumnDefinition,
  EnumDefinition,
} from '@strav/database/schema/database_representation'
import type { PostgreSQLCustomType } from '@strav/database/schema/postgres'
import { toSnakeCase, toCamelCase, toPascalCase } from '@strav/kernel/helpers/strings'
import type { GeneratorConfig, GeneratorPaths } from './config.ts'
import { resolvePaths, relativeImport, formatAndWrite } from './config.ts'

export interface GeneratedFile {
  path: string
  content: string
}

export default class ModelGenerator {
  private schemaMap: Map<string, SchemaDefinition>
  private paths: GeneratorPaths
  private config?: GeneratorConfig

  constructor(
    private schemas: SchemaDefinition[],
    private representation: DatabaseRepresentation,
    config?: GeneratorConfig
  ) {
    this.schemaMap = new Map(schemas.map(s => [s.name, s]))
    this.paths = resolvePaths(config)
    this.config = config
  }

  /** Generate all file contents without writing to disk. */
  generate(): GeneratedFile[] {
    const files: GeneratedFile[] = []

    const enumFiles = this.generateEnums()
    files.push(...enumFiles)

    const modelFiles = this.generateModels()
    files.push(...modelFiles)

    // Barrel exports
    if (enumFiles.length > 0) {
      files.push(this.generateBarrel(this.paths.enums, enumFiles, 'named'))
    }
    if (modelFiles.length > 0) {
      files.push(this.generateBarrel(this.paths.models, modelFiles, 'default'))
    }

    return files
  }

  /** Generate, format with Prettier, and write all files to disk. */
  async writeAll(): Promise<GeneratedFile[]> {
    const files = this.generate()
    await formatAndWrite(files)
    return files
  }

  // ---------------------------------------------------------------------------
  // Enum generation
  // ---------------------------------------------------------------------------

  private generateEnums(): GeneratedFile[] {
    const files: GeneratedFile[] = []
    const enumsByEntity = new Map<string, EnumDefinition[]>()

    for (const enumDef of this.representation.enums) {
      const entity = this.findEnumOwner(enumDef.name)
      const group = enumsByEntity.get(entity) ?? []
      group.push(enumDef)
      enumsByEntity.set(entity, group)
    }

    for (const [entity, enums] of enumsByEntity) {
      const lines: string[] = []
      for (let i = 0; i < enums.length; i++) {
        const enumDef = enums[i]!
        const enumName = toPascalCase(enumDef.name)
        lines.push(`export enum ${enumName} {`)
        for (const value of enumDef.values) {
          lines.push(`  ${toPascalCase(value)} = '${value}',`)
        }
        lines.push('}')
        if (i < enums.length - 1) lines.push('')
      }
      lines.push('')

      files.push({
        path: join(this.paths.enums, `${entity}.ts`),
        content: lines.join('\n'),
      })
    }

    return files
  }

  /** Find which schema owns an enum by matching pgType.name across all fields. */
  private findEnumOwner(enumName: string): string {
    for (const schema of this.schemas) {
      for (const fieldDef of Object.values(schema.fields)) {
        if (isCustomType(fieldDef.pgType) && fieldDef.pgType.name === enumName) {
          return schema.name
        }
      }
    }
    // Fallback: derive from name prefix
    const idx = enumName.lastIndexOf('_')
    return idx > 0 ? enumName.substring(0, idx) : enumName
  }

  // ---------------------------------------------------------------------------
  // Model generation
  // ---------------------------------------------------------------------------

  private generateModels(): GeneratedFile[] {
    const files: GeneratedFile[] = []
    const assocIndex = this.buildAssociationIndex()

    for (const schema of this.schemas) {
      if (schema.archetype === Archetype.Association) continue

      const table = this.representation.tables.find(t => t.name === toSnakeCase(schema.name))
      if (!table) continue

      files.push(this.generateModel(schema, table, assocIndex))
    }

    return files
  }

  private generateModel(
    schema: SchemaDefinition,
    table: TableDefinition,
    assocIndex: Map<string, AssociationEntry[]>
  ): GeneratedFile {
    const className = toPascalCase(schema.name)
    const timestampNames = new Set(['created_at', 'updated_at', 'deleted_at'])

    // Categorize columns
    const pkColumns: ColumnDefinition[] = []
    const fkColumns: ColumnDefinition[] = []
    const normalColumns: ColumnDefinition[] = []
    const timestampColumns: ColumnDefinition[] = []

    for (const col of table.columns) {
      if (col.primaryKey) {
        pkColumns.push(col)
      } else if (this.isForeignKey(col.name, table)) {
        fkColumns.push(col)
      } else if (timestampNames.has(col.name)) {
        timestampColumns.push(col)
      } else {
        normalColumns.push(col)
      }
    }

    // Sort timestamps in canonical order
    const tsOrder = ['created_at', 'updated_at', 'deleted_at']
    timestampColumns.sort((a, b) => tsOrder.indexOf(a.name) - tsOrder.indexOf(b.name))

    // Build references and associations
    const references = this.buildReferences(schema)
    const associations = assocIndex.get(schema.name) ?? []

    // Soft deletes detection
    const hasSoftDeletes = timestampColumns.some(c => c.name === 'deleted_at')

    // Track imports
    const enumImports = new Map<string, string[]>() // entity → enum names
    const modelImports = new Set<string>() // PascalCase model names
    let needsPrimaryImport = false
    let needsReferenceImport = false
    let needsAssociateImport = false

    for (const ref of references) {
      modelImports.add(ref.modelClass)
    }
    for (const assoc of associations) {
      modelImports.add(assoc.model)
    }

    // Build property lines per section
    const sections: string[][] = []

    if (pkColumns.length > 0) {
      const lines: string[] = []
      for (const col of pkColumns) {
        const propName = toCamelCase(col.name)
        const tsType = this.mapTsType(col, enumImports)
        const schemaDefault = this.formatSchemaDefault(col, schema, tsType)
        lines.push('  @primary')
        needsPrimaryImport = true
        if (schemaDefault) {
          lines.push(`  ${propName}: ${tsType} = ${schemaDefault}`)
        } else {
          lines.push(`  declare ${propName}: ${tsType}`)
        }
      }
      sections.push(lines)
    }

    if (fkColumns.length > 0) {
      const lines: string[] = []
      for (const col of fkColumns) {
        const propName = toCamelCase(col.name)
        const tsType = this.mapTsType(col, enumImports)
        const nullable = col.notNull ? '' : ' | null'
        lines.push(`  declare ${propName}: ${tsType}${nullable}`)
      }
      sections.push(lines)
    }

    if (normalColumns.length > 0) {
      const lines: string[] = []
      for (const col of normalColumns) {
        const propName = toCamelCase(col.name)
        const tsType = this.mapTsType(col, enumImports)
        const schemaDefault = this.formatSchemaDefault(col, schema, tsType)
        if (schemaDefault) {
          lines.push(`  ${propName}: ${tsType} = ${schemaDefault}`)
        } else {
          const nullable = col.notNull ? '' : ' | null'
          lines.push(`  declare ${propName}: ${tsType}${nullable}`)
        }
      }
      sections.push(lines)
    }

    if (timestampColumns.length > 0) {
      const lines: string[] = []
      for (const col of timestampColumns) {
        const propName = toCamelCase(col.name)
        const nullable = col.notNull ? '' : ' | null'
        lines.push(`  declare ${propName}: DateTime${nullable}`)
      }
      sections.push(lines)
    }

    if (references.length > 0) {
      const lines: string[] = []
      for (const ref of references) {
        lines.push(
          `  @reference({ model: '${ref.modelClass}', foreignKey: '${ref.foreignKey}', targetPK: '${ref.targetPK}' })`
        )
        lines.push(`  declare ${ref.propName}: ${ref.modelClass}`)
        needsReferenceImport = true
      }
      sections.push(lines)
    }

    if (associations.length > 0) {
      const lines: string[] = []
      for (const assoc of associations) {
        lines.push(
          `  @associate({ through: '${assoc.through}', foreignKey: '${assoc.foreignKey}', otherKey: '${assoc.otherKey}', model: '${assoc.model}', targetPK: '${assoc.targetPK}' })`
        )
        lines.push(`  declare ${assoc.property}: ${assoc.model}[]`)
        needsAssociateImport = true
      }
      sections.push(lines)
    }

    // Assemble imports
    const importLines: string[] = []
    importLines.push("import { DateTime } from 'luxon'")
    importLines.push("import BaseModel from '@strav/database/orm/base_model'")

    const decoratorImports: string[] = []
    if (needsPrimaryImport) decoratorImports.push('primary')
    if (needsReferenceImport) decoratorImports.push('reference')
    if (needsAssociateImport) decoratorImports.push('associate')
    if (decoratorImports.length > 0) {
      importLines.push(
        `import { ${decoratorImports.join(', ')} } from '@strav/database/orm/decorators'`
      )
    }

    for (const [entity, enumNames] of enumImports) {
      const enumImportPath = relativeImport(this.paths.models, this.paths.enums)
      importLines.push(`import { ${enumNames.join(', ')} } from '${enumImportPath}/${entity}'`)
    }

    for (const modelName of modelImports) {
      if (modelName === className) continue // don't import self
      const fileName = toSnakeCase(modelName)
      importLines.push(`import type ${modelName} from './${fileName}'`)
    }

    // Assemble file
    const lines: string[] = []
    lines.push('// Generated by Strav — DO NOT EDIT')
    lines.push(...importLines)
    lines.push('')
    lines.push(`export default class ${(className)} extends BaseModel {`)

    if (hasSoftDeletes) {
      lines.push('  static override softDeletes = true')
      if (sections.length > 0) lines.push('')
    }

    for (let i = 0; i < sections.length; i++) {
      lines.push(...sections[i]!)
      if (i < sections.length - 1) lines.push('')
    }

    lines.push('}')
    lines.push('')

    return {
      path: join(this.paths.models, `${toSnakeCase(schema.name)}.ts`),
      content: lines.join('\n'),
    }
  }

  // ---------------------------------------------------------------------------
  // Type mapping
  // ---------------------------------------------------------------------------

  /** Map a column to its TypeScript type string. Registers enum imports as a side-effect. */
  private mapTsType(col: ColumnDefinition, enumImports: Map<string, string[]>): string {
    const pgType = col.pgType

    // Custom enum type
    if (isCustomType(pgType)) {
      const enumName = toPascalCase(pgType.name)
      const ownerEntity = this.findEnumOwner(pgType.name)
      const existing = enumImports.get(ownerEntity) ?? []
      if (!existing.includes(enumName)) {
        existing.push(enumName)
        enumImports.set(ownerEntity, existing)
      }
      return enumName
    }

    if (typeof pgType !== 'string') return 'unknown'

    switch (pgType) {
      case 'serial':
      case 'integer':
      case 'smallint':
      case 'smallserial':
      case 'real':
      case 'double_precision':
      case 'decimal':
      case 'numeric':
      case 'money':
        return 'number'

      case 'bigserial':
      case 'bigint':
        return 'bigint'

      case 'varchar':
      case 'character_varying':
      case 'char':
      case 'character':
      case 'text':
      case 'uuid':
        return 'string'

      case 'boolean':
        return 'boolean'

      case 'timestamptz':
      case 'timestamp':
        return 'DateTime'

      case 'json':
      case 'jsonb':
        return 'Record<string, unknown>'

      case 'date':
      case 'time':
      case 'timetz':
      case 'interval':
        return 'string'

      default:
        return 'string'
    }
  }

  /**
   * If the column has a schema-level default, return the TS expression for it.
   * Returns null if no schema default exists.
   */
  private formatSchemaDefault(
    col: ColumnDefinition,
    schema: SchemaDefinition,
    tsType: string
  ): string | null {
    const fieldDef = this.findFieldForColumn(col.name, schema)
    if (!fieldDef || fieldDef.defaultValue === undefined) return null

    const defaultValue = fieldDef.defaultValue

    // Enum default
    if (isCustomType(col.pgType)) {
      const enumName = toPascalCase(col.pgType.name)
      const member = toPascalCase(String(defaultValue))
      return `${enumName}.${member}`
    }

    // Literal defaults
    if (typeof defaultValue === 'string') return `'${defaultValue}'`
    if (typeof defaultValue === 'number') return String(defaultValue)
    if (typeof defaultValue === 'boolean') return String(defaultValue)

    return null
  }

  /**
   * Find the schema field definition that corresponds to a given column name.
   * Only returns non-reference fields (FK columns derived from references have no direct field).
   */
  private findFieldForColumn(
    colName: string,
    schema: SchemaDefinition
  ): import('@strav/database/schema/field_definition').FieldDefinition | null {
    for (const [fieldName, fieldDef] of Object.entries(schema.fields)) {
      if (fieldDef.references) continue
      if (toSnakeCase(fieldName) === colName) {
        return fieldDef
      }
    }
    return null
  }

  // ---------------------------------------------------------------------------
  // Reference detection
  // ---------------------------------------------------------------------------

  private buildReferences(
    schema: SchemaDefinition
  ): { propName: string; modelClass: string; foreignKey: string; targetPK: string }[] {
    const refs: { propName: string; modelClass: string; foreignKey: string; targetPK: string }[] =
      []

    // Parent references
    if (schema.parents) {
      for (const parentName of schema.parents) {
        const parentPK = this.findSchemaPK(parentName)
        const fkCol = `${toSnakeCase(parentName)}_${toSnakeCase(parentPK)}`
        refs.push({
          propName: toCamelCase(parentName),
          modelClass: this.prefixModelName(parentName),
          foreignKey: toCamelCase(fkCol),
          targetPK: parentPK,
        })
      }
    }

    // Reference fields
    for (const [fieldName, fieldDef] of Object.entries(schema.fields)) {
      if (fieldDef.references) {
        const refPK = this.findSchemaPK(fieldDef.references)
        const fkCol = `${toSnakeCase(fieldName)}_${toSnakeCase(refPK)}`
        refs.push({
          propName: toCamelCase(fieldName),
          modelClass: this.prefixModelName(fieldDef.references),
          foreignKey: toCamelCase(fkCol),
          targetPK: refPK,
        })
      }
    }

    return refs
  }

  /** Find the primary key field name (camelCase) for a schema. Defaults to 'id'. */
  private findSchemaPK(schemaName: string): string {
    const schema = this.schemaMap.get(schemaName)
    if (!schema) return 'id'
    for (const [fieldName, fieldDef] of Object.entries(schema.fields)) {
      if (fieldDef.primaryKey) return fieldName
    }
    return 'id'
  }

  // ---------------------------------------------------------------------------
  // Association index
  // ---------------------------------------------------------------------------

  /**
   * Build an index: entity name → association entries.
   * Only association schemas with an `as` option produce entries.
   */
  private buildAssociationIndex(): Map<string, AssociationEntry[]> {
    const index = new Map<string, AssociationEntry[]>()

    for (const schema of this.schemas) {
      if (schema.archetype !== Archetype.Association || !schema.associates || !schema.as) continue

      const [entityA, entityB] = schema.associates!
      const pivotTable = toSnakeCase(schema.name)
      const pkA = this.findSchemaPK(entityA!)
      const pkB = this.findSchemaPK(entityB!)
      const fkA = `${toSnakeCase(entityA!)}_${toSnakeCase(pkA)}`
      const fkB = `${toSnakeCase(entityB!)}_${toSnakeCase(pkB)}`

      // Entity A gets a property pointing to Entity B
      if (schema.as![entityA!]) {
        const entries = index.get(entityA!) ?? []
        entries.push({
          property: schema.as![entityA!]!,
          through: pivotTable,
          foreignKey: fkA,
          otherKey: fkB,
          model: this.prefixModelName(entityB!),
          targetPK: pkB,
        })
        index.set(entityA!, entries)
      }

      // Entity B gets a property pointing to Entity A
      if (schema.as![entityB!]) {
        const entries = index.get(entityB!) ?? []
        entries.push({
          property: schema.as![entityB!]!,
          through: pivotTable,
          foreignKey: fkB,
          otherKey: fkA,
          model: this.prefixModelName(entityA!),
          targetPK: pkA,
        })
        index.set(entityB!, entries)
      }
    }

    return index
  }

  // ---------------------------------------------------------------------------
  // Barrel generation
  // ---------------------------------------------------------------------------

  /**
   * Generate a barrel (index.ts) file that re-exports all generated files
   * in a directory. `mode` controls the export style:
   *  - `'default'` → `export { default as ClassName } from './file'`
   *  - `'named'`   → `export * from './file'`
   */
  private generateBarrel(
    dir: string,
    files: GeneratedFile[],
    mode: 'default' | 'named'
  ): GeneratedFile {
    const lines: string[] = ['// Generated by Strav — DO NOT EDIT', '']

    for (const file of files) {
      const basename = file.path.split('/').pop()!.replace(/\.ts$/, '')
      if (mode === 'named') {
        lines.push(`export * from './${basename}'`)
      } else {
        const className = (toPascalCase(basename))
        lines.push(`export { default as ${className} } from './${basename}'`)
      }
    }

    lines.push('')

    return {
      path: join(dir, 'index.ts'),
      content: lines.join('\n'),
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /** Convert a schema name to its generated model class name. */
  private prefixModelName(modelName: string): string {
    return toPascalCase(modelName)
  }

  private isForeignKey(columnName: string, table: TableDefinition): boolean {
    return table.foreignKeys.some(fk => fk.columns.includes(columnName))
  }
}

interface AssociationEntry {
  property: string
  through: string
  foreignKey: string
  otherKey: string
  model: string
  targetPK: string
}

function isCustomType(pgType: unknown): pgType is PostgreSQLCustomType {
  return typeof pgType === 'object' && pgType !== null && (pgType as any).type === 'custom'
}
