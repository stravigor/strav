import { join } from 'node:path'
import { Archetype } from '@strav/database/schema/types'
import type { SchemaDefinition } from '@strav/database/schema/types'
import type {
  DatabaseRepresentation,
  TableDefinition,
  ColumnDefinition,
} from '@strav/database/schema/database_representation'
import type { FieldDefinition, FieldValidator } from '@strav/database/schema/field_definition'
import type { PostgreSQLCustomType } from '@strav/database/schema/postgres'
import { toSnakeCase, toCamelCase, toPascalCase } from '@strav/kernel/helpers/strings'
import type { GeneratedFile } from './model_generator.ts'
import type { GeneratorConfig, GeneratorPaths, WriteResult } from './config.ts'
import { resolvePaths, relativeImport, formatAndWrite } from './config.ts'

// ---------------------------------------------------------------------------
// Archetype behaviour tables
// ---------------------------------------------------------------------------

/** Which event constants each archetype produces. */
const ARCHETYPE_EVENTS: Record<Archetype, string[]> = {
  [Archetype.Entity]: ['CREATED', 'UPDATED', 'SYNCED', 'DELETED'],
  [Archetype.Attribute]: ['CREATED', 'UPDATED', 'SYNCED', 'DELETED'],
  [Archetype.Contribution]: ['CREATED', 'UPDATED', 'SYNCED', 'DELETED'],
  [Archetype.Reference]: ['CREATED', 'UPDATED', 'SYNCED', 'DELETED'],
  [Archetype.Component]: ['UPDATED', 'SYNCED'],
  [Archetype.Event]: ['CREATED'],
  [Archetype.Configuration]: ['UPDATED', 'SYNCED'],
  [Archetype.Association]: [],
}

/** Policy methods per archetype. */
const ARCHETYPE_POLICY: Record<Archetype, string[]> = {
  [Archetype.Entity]: ['canList', 'canView', 'canCreate', 'canUpdate', 'canDelete'],
  [Archetype.Attribute]: ['canList', 'canView', 'canCreate', 'canUpdate', 'canDelete'],
  [Archetype.Reference]: ['canList', 'canView', 'canCreate', 'canUpdate', 'canDelete'],
  [Archetype.Contribution]: [
    'canList',
    'canView',
    'canCreate',
    'canUpdate',
    'canDelete',
    'canModerate',
  ],
  [Archetype.Component]: ['canList', 'canView', 'canUpdate'],
  [Archetype.Event]: ['canList', 'canView', 'canAppend'],
  [Archetype.Configuration]: ['canView', 'canUpsert', 'canReset'],
  [Archetype.Association]: [],
}

/** Service methods per archetype. */
const ARCHETYPE_SERVICE: Record<Archetype, string[]> = {
  [Archetype.Entity]: ['list', 'find', 'create', 'update', 'delete'],
  [Archetype.Attribute]: ['listByParent', 'find', 'create', 'update', 'delete'],
  [Archetype.Contribution]: ['listByParent', 'find', 'create', 'update', 'delete'],
  [Archetype.Reference]: ['list', 'find', 'create', 'update', 'delete'],
  [Archetype.Component]: ['listByParent', 'find', 'update'],
  [Archetype.Event]: ['listByParent', 'find', 'append'],
  [Archetype.Configuration]: ['get', 'upsert', 'reset'],
  [Archetype.Association]: [],
}

/** Controller actions per archetype. */
const ARCHETYPE_CONTROLLER: Record<Archetype, string[]> = {
  [Archetype.Entity]: ['index', 'show', 'store', 'update', 'destroy'],
  [Archetype.Attribute]: ['index', 'show', 'store', 'update', 'destroy'],
  [Archetype.Contribution]: ['index', 'show', 'store', 'update', 'destroy'],
  [Archetype.Reference]: ['index', 'show', 'store', 'update', 'destroy'],
  [Archetype.Component]: ['index', 'show', 'update'],
  [Archetype.Event]: ['index', 'show', 'store'],
  [Archetype.Configuration]: ['show', 'update', 'destroy'],
  [Archetype.Association]: [],
}

/** Maps controller action → policy method + whether it receives a loaded resource. */
const ACTION_POLICY: Record<
  Archetype,
  Record<string, { method: string; withResource: boolean }>
> = {
  [Archetype.Entity]: {
    index: { method: 'canList', withResource: false },
    show: { method: 'canView', withResource: true },
    store: { method: 'canCreate', withResource: false },
    update: { method: 'canUpdate', withResource: true },
    destroy: { method: 'canDelete', withResource: true },
  },
  [Archetype.Attribute]: {
    index: { method: 'canList', withResource: false },
    show: { method: 'canView', withResource: true },
    store: { method: 'canCreate', withResource: false },
    update: { method: 'canUpdate', withResource: true },
    destroy: { method: 'canDelete', withResource: true },
  },
  [Archetype.Reference]: {
    index: { method: 'canList', withResource: false },
    show: { method: 'canView', withResource: true },
    store: { method: 'canCreate', withResource: false },
    update: { method: 'canUpdate', withResource: true },
    destroy: { method: 'canDelete', withResource: true },
  },
  [Archetype.Contribution]: {
    index: { method: 'canList', withResource: false },
    show: { method: 'canView', withResource: true },
    store: { method: 'canCreate', withResource: false },
    update: { method: 'canUpdate', withResource: true },
    destroy: { method: 'canDelete', withResource: true },
  },
  [Archetype.Component]: {
    index: { method: 'canList', withResource: false },
    show: { method: 'canView', withResource: true },
    update: { method: 'canUpdate', withResource: true },
  },
  [Archetype.Event]: {
    index: { method: 'canList', withResource: false },
    show: { method: 'canView', withResource: true },
    store: { method: 'canAppend', withResource: false },
  },
  [Archetype.Configuration]: {
    show: { method: 'canView', withResource: true },
    update: { method: 'canUpsert', withResource: false },
    destroy: { method: 'canReset', withResource: false },
  },
  [Archetype.Association]: {},
}

/** Archetypes that have a parent FK (dependent archetypes). */
const PARENT_FK_ARCHETYPES: Set<Archetype> = new Set([
  Archetype.Component,
  Archetype.Attribute,
  Archetype.Event,
  Archetype.Configuration,
  Archetype.Contribution,
])

/** System-managed column names that should never appear in validators. */
const SYSTEM_COLUMNS = new Set(['id', 'created_at', 'updated_at', 'deleted_at'])

// ---------------------------------------------------------------------------
// ApiGenerator
// ---------------------------------------------------------------------------

export default class ApiGenerator {
  private schemaMap: Map<string, SchemaDefinition>
  private paths: GeneratorPaths

  constructor(
    private schemas: SchemaDefinition[],
    private representation: DatabaseRepresentation,
    config?: GeneratorConfig
  ) {
    this.schemaMap = new Map(schemas.map(s => [s.name, s]))
    this.paths = resolvePaths(config)
  }

  /** Generate all file contents without writing to disk. */
  generate(): GeneratedFile[] {
    const eventFiles: GeneratedFile[] = []
    const validatorFiles: GeneratedFile[] = []
    const policyFiles: GeneratedFile[] = []
    const serviceFiles: GeneratedFile[] = []
    const controllerFiles: GeneratedFile[] = []
    const resourceFiles: GeneratedFile[] = []

    for (const schema of this.schemas) {
      if (schema.archetype === Archetype.Association) continue

      const table = this.representation.tables.find(t => t.name === toSnakeCase(schema.name))
      if (!table) continue

      eventFiles.push(this.generateEvents(schema))
      validatorFiles.push(this.generateValidator(schema, table))
      policyFiles.push(this.generatePolicy(schema))
      serviceFiles.push(this.generateService(schema, table))
      controllerFiles.push(this.generateController(schema, table))
      resourceFiles.push(this.generateResource(schema, table))
    }

    const files = [
      ...eventFiles,
      ...validatorFiles,
      ...policyFiles,
      ...serviceFiles,
      ...controllerFiles,
      ...resourceFiles,
    ]

    // Barrel exports
    if (eventFiles.length > 0) {
      files.push(this.generateBarrel(this.paths.events, eventFiles, 'named'))
    }
    if (validatorFiles.length > 0) {
      files.push(this.generateBarrel(this.paths.validators, validatorFiles, 'named'))
    }
    if (policyFiles.length > 0) {
      files.push(this.generateBarrel(this.paths.policies, policyFiles, 'default'))
    }
    if (serviceFiles.length > 0) {
      files.push(this.generateBarrel(this.paths.services, serviceFiles, 'default'))
    }
    if (controllerFiles.length > 0) {
      files.push(this.generateBarrel(this.paths.controllers, controllerFiles, 'default'))
    }
    if (resourceFiles.length > 0) {
      files.push(this.generateBarrel(this.paths.resources, resourceFiles, 'default'))
    }

    return files
  }

  /** Generate, format with Prettier, and write all files to disk. */
  async writeAll(force?: boolean): Promise<WriteResult> {
    const files = this.generate()
    return formatAndWrite(files, { force })
  }

  // ---------------------------------------------------------------------------
  // 1. Event constants
  // ---------------------------------------------------------------------------

  private generateEvents(schema: SchemaDefinition): GeneratedFile {
    const className = toPascalCase(schema.name)
    const snakeName = toSnakeCase(schema.name)
    const events = ARCHETYPE_EVENTS[schema.archetype] ?? []

    const lines: string[] = [
      '// Generated by Strav — DO NOT EDIT',
      '',
      `export const ${className}Events = {`,
    ]

    for (const event of events) {
      lines.push(`  ${event}: '${snakeName}.${event.toLowerCase()}',`)
    }

    lines.push('} as const')
    lines.push('')

    return {
      path: join(this.paths.events, `${snakeName}.ts`),
      content: lines.join('\n'),
    }
  }

  // ---------------------------------------------------------------------------
  // 2. Validator rules
  // ---------------------------------------------------------------------------

  private generateValidator(schema: SchemaDefinition, table: TableDefinition): GeneratedFile {
    const className = toPascalCase(schema.name)
    const snakeName = toSnakeCase(schema.name)
    const fields = this.getValidatableFields(schema, table)

    // Collect which rule imports we need
    const ruleImports = new Set<string>()
    const enumImports = new Map<string, string[]>() // ownerEntity → [EnumName, ...]
    const storeRules: [string, string[]][] = []
    const updateRules: [string, string[]][] = []

    for (const { fieldName, fieldDef, column } of fields) {
      const camelName = toCamelCase(fieldName)

      // Detect custom enum type → track import, pass enum name to rule builder
      let enumName: string | undefined
      if (isCustomType(fieldDef.pgType) && fieldDef.pgType.name) {
        enumName = toPascalCase(fieldDef.pgType.name)
        const ownerEntity = this.findEnumOwner(fieldDef.pgType.name)
        const existing = enumImports.get(ownerEntity) ?? []
        if (!existing.includes(enumName)) {
          existing.push(enumName)
          enumImports.set(ownerEntity, existing)
        }
      }

      const store = this.buildFieldRules(fieldDef, column, true, enumName)
      const update = this.buildFieldRules(fieldDef, column, false, enumName)

      for (const r of store) ruleImports.add(r.name)
      for (const r of update) ruleImports.add(r.name)

      if (store.length > 0) storeRules.push([camelName, store.map(r => r.code)])
      if (update.length > 0) updateRules.push([camelName, update.map(r => r.code)])
    }

    const lines: string[] = [
      '// Generated by Strav — DO NOT EDIT',
      `import { ${[...ruleImports].sort().join(', ')} } from '@strav/http/validation'`,
      `import type { RuleSet } from '@strav/http/validation'`,
    ]

    const enumImportPath = relativeImport(this.paths.validators, this.paths.enums)
    for (const [entity, enums] of enumImports) {
      lines.push(`import { ${enums.join(', ')} } from '${enumImportPath}/${toSnakeCase(entity)}'`)
    }

    lines.push('')
    lines.push(`export const ${className}Rules: Record<string, RuleSet> = {`)

    // Store rules
    const hasStore = ARCHETYPE_SERVICE[schema.archetype]?.some(
      m => m === 'create' || m === 'append' || m === 'upsert'
    )
    if (hasStore && storeRules.length > 0) {
      lines.push('  store: {')
      for (const [name, rules] of storeRules) {
        lines.push(`    ${name}: [${rules.join(', ')}],`)
      }
      lines.push('  },')
    }

    // Update rules
    const hasUpdate = ARCHETYPE_SERVICE[schema.archetype]?.some(
      m => m === 'update' || m === 'upsert'
    )
    if (hasUpdate && updateRules.length > 0) {
      lines.push('  update: {')
      for (const [name, rules] of updateRules) {
        lines.push(`    ${name}: [${rules.join(', ')}],`)
      }
      lines.push('  },')
    }

    lines.push('}')
    lines.push('')

    return {
      path: join(this.paths.validators, `${snakeName}_validator.ts`),
      content: lines.join('\n'),
    }
  }

  /** Get fields that should appear in validators (exclude system-managed columns). */
  private getValidatableFields(
    schema: SchemaDefinition,
    table: TableDefinition
  ): { fieldName: string; fieldDef: FieldDefinition; column: ColumnDefinition | undefined }[] {
    const parentFkCols = new Set(
      (schema.parents ?? []).map(p => `${toSnakeCase(p)}_${toSnakeCase(this.findSchemaPK(p))}`)
    )

    const result: {
      fieldName: string
      fieldDef: FieldDefinition
      column: ColumnDefinition | undefined
    }[] = []

    for (const [fieldName, fieldDef] of Object.entries(schema.fields)) {
      if (fieldDef.primaryKey) continue

      // Reference fields → use FK column name and referenced PK type
      if (fieldDef.references) {
        const refPK = this.findSchemaPK(fieldDef.references)
        const fkColName = `${toSnakeCase(fieldName)}_${toSnakeCase(refPK)}`
        if (SYSTEM_COLUMNS.has(fkColName)) continue
        if (parentFkCols.has(fkColName)) continue

        // Resolve the referenced PK's pgType for validation
        let fkPgType = fieldDef.pgType
        const refSchema = this.schemaMap.get(fieldDef.references)
        if (refSchema) {
          for (const [, fd] of Object.entries(refSchema.fields)) {
            if (fd.primaryKey) {
              fkPgType = fd.pgType
              break
            }
          }
        }

        const column = table.columns.find(c => c.name === fkColName)
        result.push({
          fieldName: fkColName,
          fieldDef: { ...fieldDef, pgType: fkPgType, references: undefined, validators: [] },
          column,
        })
        continue
      }

      const colName = toSnakeCase(fieldName)
      if (SYSTEM_COLUMNS.has(colName)) continue
      if (parentFkCols.has(colName)) continue

      const column = table.columns.find(c => c.name === colName)
      result.push({ fieldName, fieldDef, column })
    }

    return result
  }

  /** Build validation rule calls for a single field. */
  private buildFieldRules(
    fieldDef: FieldDefinition,
    column: ColumnDefinition | undefined,
    isStore: boolean,
    enumName?: string
  ): { name: string; code: string }[] {
    const rules: { name: string; code: string }[] = []

    // required — only on store, when field is required
    if (isStore && fieldDef.required) {
      rules.push({ name: 'required', code: 'required()' })
    }

    // type rule based on pgType
    const typeRule = this.pgTypeToRule(fieldDef.pgType)
    if (typeRule) rules.push(typeRule)

    // enum: custom type → enumOf(Enum), inline values → oneOf([...])
    if (enumName) {
      rules.push({ name: 'enumOf', code: `enumOf(${enumName})` })
    } else if (fieldDef.enumValues?.length) {
      const vals = fieldDef.enumValues.map(v => `'${v}'`).join(', ')
      rules.push({ name: 'oneOf', code: `oneOf([${vals}])` })
    }

    // length constraint for varchar
    if (fieldDef.length) {
      rules.push({ name: 'max', code: `max(${fieldDef.length})` })
    }

    // Schema-level validators
    for (const v of fieldDef.validators) {
      const rule = this.validatorToRule(v)
      if (rule) rules.push(rule)
    }

    return rules
  }

  /** Map a PostgreSQL type to its corresponding validation rule. */
  private pgTypeToRule(pgType: unknown): { name: string; code: string } | null {
    if (typeof pgType !== 'string') return null

    switch (pgType) {
      case 'varchar':
      case 'character_varying':
      case 'char':
      case 'character':
      case 'text':
      case 'uuid':
        return { name: 'string', code: 'string()' }
      case 'integer':
      case 'smallint':
      case 'serial':
      case 'smallserial':
        return { name: 'integer', code: 'integer()' }
      case 'bigint':
      case 'bigserial':
      case 'real':
      case 'double_precision':
      case 'decimal':
      case 'numeric':
      case 'money':
        return { name: 'number', code: 'number()' }
      case 'boolean':
        return { name: 'boolean', code: 'boolean()' }
      default:
        return null
    }
  }

  /** Convert a schema FieldValidator to a rule call. */
  private validatorToRule(v: FieldValidator): { name: string; code: string } | null {
    switch (v.type) {
      case 'min':
        return { name: 'min', code: `min(${v.params?.value ?? 0})` }
      case 'max':
        return { name: 'max', code: `max(${v.params?.value ?? 0})` }
      case 'email':
        return { name: 'email', code: 'email()' }
      case 'url':
        return { name: 'url', code: 'url()' }
      case 'regex':
        return v.params?.pattern ? { name: 'regex', code: `regex(${v.params.pattern})` } : null
      default:
        return null
    }
  }

  // ---------------------------------------------------------------------------
  // 3. Policy skeleton
  // ---------------------------------------------------------------------------

  private generatePolicy(schema: SchemaDefinition): GeneratedFile {
    const className = toPascalCase(schema.name)
    const snakeName = toSnakeCase(schema.name)
    const methods = ARCHETYPE_POLICY[schema.archetype] ?? []

    const lines: string[] = [
      '// Generated by Strav — DO NOT EDIT',
      `import { allow } from '@strav/http/policy'`,
      `import type { PolicyResult } from '@strav/http/policy'`,
      '',
      `export default class ${className}Policy {`,
    ]

    const isDependent = PARENT_FK_ARCHETYPES.has(schema.archetype)

    for (let i = 0; i < methods.length; i++) {
      const method = methods[i]!
      // Methods that receive a resource as second arg
      const withResource = ['canView', 'canUpdate', 'canDelete', 'canModerate'].includes(method)
      let params: string
      if (withResource) {
        params = `actor: any, ${toCamelCase(schema.name)}: any`
      } else if (isDependent) {
        params = 'actor: any, parentId: string | number'
      } else {
        params = 'actor: any'
      }

      lines.push(`  static ${method}(${params}): PolicyResult {`)
      lines.push('    return allow()')
      lines.push('  }')
      if (i < methods.length - 1) lines.push('')
    }

    lines.push('}')
    lines.push('')

    return {
      path: join(this.paths.policies, `${snakeName}_policy.ts`),
      content: lines.join('\n'),
    }
  }

  // ---------------------------------------------------------------------------
  // 4. Service
  // ---------------------------------------------------------------------------

  private generateService(schema: SchemaDefinition, table: TableDefinition): GeneratedFile {
    const className = toPascalCase(schema.name)
    const snakeName = toSnakeCase(schema.name)
    const camelName = toCamelCase(schema.name)
    const methods = ARCHETYPE_SERVICE[schema.archetype] ?? []
    const isDependent = PARENT_FK_ARCHETYPES.has(schema.archetype)
    const parentName = schema.parents?.[0]
    const parentClassName = parentName ? toPascalCase(parentName) : null
    const parentFkProp = parentName
      ? toCamelCase(`${toSnakeCase(parentName)}_${toSnakeCase(this.findSchemaPK(parentName))}`)
      : null

    const needsQuery = methods.some(
      m => m === 'list' || m === 'listByParent' || m === 'get' || m === 'upsert' || m === 'reset'
    )

    const modelImport = relativeImport(this.paths.services, this.paths.models)
    const eventImport = relativeImport(this.paths.services, this.paths.events)

    const lines: string[] = [
      '// Generated by Strav — DO NOT EDIT',
      `import { inject } from '@strav/kernel/core/inject'`,
      `import ${className} from '${modelImport}/${snakeName}'`,
      `import { ${className}Events } from '${eventImport}/${snakeName}'`,
      `import Emitter from '@strav/kernel/events/emitter'`,
    ]
    if (needsQuery) {
      lines.push(`import { query } from '@strav/database/database'`)
    }
    lines.push('')
    lines.push(`@inject`)
    lines.push(`export default class ${className}Service {`)

    for (let i = 0; i < methods.length; i++) {
      const method = methods[i]!
      lines.push(...this.generateServiceMethod(method, schema, className, camelName, parentFkProp))
      if (i < methods.length - 1) lines.push('')
    }

    lines.push('}')
    lines.push('')

    return {
      path: join(this.paths.services, `${snakeName}_service.ts`),
      content: lines.join('\n'),
    }
  }

  private generateServiceMethod(
    method: string,
    schema: SchemaDefinition,
    className: string,
    camelName: string,
    parentFkProp: string | null
  ): string[] {
    const lines: string[] = []

    switch (method) {
      case 'list':
        lines.push(`  async list(page: number, perPage: number) {`)
        lines.push(`    return query(${className}).paginate(page, perPage)`)
        lines.push(`  }`)
        break

      case 'listByParent':
        lines.push(
          `  async listByParent(parentId: string | number, page: number, perPage: number) {`
        )
        lines.push(
          `    return query(${className}).where('${parentFkProp}', parentId).paginate(page, perPage)`
        )
        lines.push(`  }`)
        break

      case 'find':
        lines.push(`  async find(id: string | number) {`)
        lines.push(`    return ${className}.find(id)`)
        lines.push(`  }`)
        break

      case 'create':
        lines.push(`  async create(data: Record<string, unknown>) {`)
        lines.push(`    const ${camelName} = new ${className}()`)
        lines.push(`    ${camelName}.merge(data)`)
        lines.push(`    await ${camelName}.save()`)
        lines.push(`    await Emitter.emit(${className}Events.CREATED, ${camelName})`)
        lines.push(`    return ${camelName}`)
        lines.push(`  }`)
        break

      case 'append':
        lines.push(`  async append(data: Record<string, unknown>) {`)
        lines.push(`    const ${camelName} = new ${className}()`)
        lines.push(`    ${camelName}.merge(data)`)
        lines.push(`    await ${camelName}.save()`)
        lines.push(`    await Emitter.emit(${className}Events.CREATED, ${camelName})`)
        lines.push(`    return ${camelName}`)
        lines.push(`  }`)
        break

      case 'update':
        lines.push(`  async update(id: string | number, data: Record<string, unknown>) {`)
        lines.push(`    const ${camelName} = await ${className}.find(id)`)
        lines.push(`    if (!${camelName}) return null`)
        lines.push(`    ${camelName}.merge(data)`)
        lines.push(`    await ${camelName}.save()`)
        lines.push(`    await Emitter.emit(${className}Events.UPDATED, ${camelName})`)
        lines.push(`    return ${camelName}`)
        lines.push(`  }`)
        break

      case 'delete':
        lines.push(`  async delete(id: string | number) {`)
        lines.push(`    const ${camelName} = await ${className}.find(id)`)
        lines.push(`    if (!${camelName}) return false`)
        lines.push(`    await ${camelName}.delete()`)
        lines.push(`    await Emitter.emit(${className}Events.DELETED, ${camelName})`)
        lines.push(`    return true`)
        lines.push(`  }`)
        break

      case 'get':
        lines.push(`  async get(parentId: string | number) {`)
        lines.push(`    return query(${className}).where('${parentFkProp}', parentId).first()`)
        lines.push(`  }`)
        break

      case 'upsert':
        lines.push(`  async upsert(parentId: string | number, data: Record<string, unknown>) {`)
        lines.push(
          `    let ${camelName} = await query(${className}).where('${parentFkProp}', parentId).first()`
        )
        lines.push(`    if (${camelName}) {`)
        lines.push(`      ${camelName}.merge(data)`)
        lines.push(`    } else {`)
        lines.push(`      ${camelName} = new ${className}()`)
        lines.push(`      ${camelName}.merge({ ${parentFkProp}: parentId, ...data })`)
        lines.push(`    }`)
        lines.push(`    await ${camelName}.save()`)
        lines.push(`    await Emitter.emit(${className}Events.UPDATED, ${camelName})`)
        lines.push(`    return ${camelName}`)
        lines.push(`  }`)
        break

      case 'reset':
        lines.push(`  async reset(parentId: string | number) {`)
        lines.push(
          `    const ${camelName} = await query(${className}).where('${parentFkProp}', parentId).first()`
        )
        lines.push(`    if (!${camelName}) return false`)
        lines.push(`    await ${camelName}.delete()`)
        lines.push(`    return true`)
        lines.push(`  }`)
        break
    }

    return lines
  }

  // ---------------------------------------------------------------------------
  // 5. Controller
  // ---------------------------------------------------------------------------

  private generateController(schema: SchemaDefinition, table: TableDefinition): GeneratedFile {
    const className = toPascalCase(schema.name)
    const snakeName = toSnakeCase(schema.name)
    const camelName = toCamelCase(schema.name)
    const actions = ARCHETYPE_CONTROLLER[schema.archetype] ?? []
    const isDependent = PARENT_FK_ARCHETYPES.has(schema.archetype)
    const isConfiguration = schema.archetype === Archetype.Configuration
    const isEvent = schema.archetype === Archetype.Event

    const serviceImport = relativeImport(this.paths.controllers, this.paths.services)
    const validatorImport = relativeImport(this.paths.controllers, this.paths.validators)
    const policyImport = relativeImport(this.paths.controllers, this.paths.policies)
    const resourceImport = relativeImport(this.paths.controllers, this.paths.resources)

    const lines: string[] = [
      '// Generated by Strav — DO NOT EDIT',
      `import { inject } from '@strav/kernel/core/inject'`,
      `import type Context from '@strav/http/http/context'`,
      `import { validate } from '@strav/http/validation'`,
      `import ${className}Service from '${serviceImport}/${snakeName}_service'`,
      `import { ${className}Rules } from '${validatorImport}/${snakeName}_validator'`,
      `import ${className}Policy from '${policyImport}/${snakeName}_policy'`,
      `import ${className}Resource from '${resourceImport}/${snakeName}_resource'`,
      '',
      `@inject`,
      `export default class ${className}Controller {`,
      `  constructor(protected service: ${className}Service) {}`,
    ]

    for (const action of actions) {
      lines.push('')
      lines.push(
        ...this.generateControllerAction(
          action,
          schema,
          className,
          camelName,
          isDependent,
          isConfiguration,
          isEvent
        )
      )
    }

    lines.push('}')
    lines.push('')

    return {
      path: join(this.paths.controllers, `${snakeName}_controller.ts`),
      content: lines.join('\n'),
    }
  }

  private generateControllerAction(
    action: string,
    schema: SchemaDefinition,
    className: string,
    camelName: string,
    isDependent: boolean,
    isConfiguration: boolean,
    isEvent: boolean
  ): string[] {
    const lines: string[] = []
    const parentParam = isDependent ? `ctx.params.parentId!` : null
    const policy = ACTION_POLICY[schema.archetype]?.[action]
    const policyClass = `${className}Policy`

    // Whether there are content lines above (to decide blank line before comment)
    let hasContentAbove = false

    // Helper: emit policy guard (no resource)
    const guardNoResource = () => {
      if (!policy) return
      if (hasContentAbove) lines.push('')
      lines.push(`    // Check policy`)
      lines.push(`    const actor = ctx.get('user')`)
      const policyArgs = isDependent ? `actor, ${parentParam}` : 'actor'
      lines.push(`    const access = ${policyClass}.${policy.method}(${policyArgs})`)
      lines.push(
        `    if (!access.allowed) return ctx.json({ error: access.reason }, access.status)`
      )
    }

    // Helper: emit policy guard (with resource)
    const guardWithResource = (resourceVar: string) => {
      if (!policy) return
      if (hasContentAbove) lines.push('')
      lines.push(`    // Check policy`)
      lines.push(`    const actor = ctx.get('user')`)
      lines.push(`    const access = ${policyClass}.${policy.method}(actor, ${resourceVar})`)
      lines.push(
        `    if (!access.allowed) return ctx.json({ error: access.reason }, access.status)`
      )
    }

    switch (action) {
      case 'index':
        lines.push(`  async index(ctx: Context) {`)
        guardNoResource()
        lines.push('')
        lines.push(`    // Pagination`)
        lines.push(`    const page = Number(ctx.query.get('page')) || 1`)
        lines.push(`    const perPage = Number(ctx.query.get('perPage')) || 20`)
        lines.push('')
        lines.push(`    // Execute business logic`)
        if (isDependent) {
          lines.push(
            `    const result = await this.service.listByParent(${parentParam}, page, perPage)`
          )
        } else {
          lines.push(`    const result = await this.service.list(page, perPage)`)
        }
        lines.push('')
        lines.push(`    // Done.`)
        lines.push(`    return ctx.json(${className}Resource.paginate(result))`)
        lines.push(`  }`)
        break

      case 'show':
        lines.push(`  async show(ctx: Context) {`)
        if (isConfiguration) {
          lines.push(`    const item = await this.service.get(ctx.params.parentId!)`)
        } else {
          lines.push(`    const item = await this.service.find(ctx.params.id!)`)
        }
        lines.push(`    if (!item) return ctx.json({ error: 'Not Found' }, 404)`)
        hasContentAbove = true
        if (policy?.withResource) {
          guardWithResource('item')
        } else {
          guardNoResource()
        }
        lines.push('')
        lines.push(`    // Done.`)
        lines.push(`    return ctx.json(${className}Resource.make(item))`)
        lines.push(`  }`)
        break

      case 'store': {
        const serviceCall = isEvent ? 'this.service.append' : 'this.service.create'
        lines.push(`  async store(ctx: Context) {`)
        guardNoResource()
        lines.push('')
        lines.push(`    // Validate user input`)
        lines.push(`    const body = await ctx.body<Record<string, unknown>>()`)
        lines.push(
          `    const { data: validated, errors } = validate(body, ${className}Rules.store!)`
        )
        lines.push(`    if (errors) return ctx.json({ errors }, 422)`)
        lines.push('')
        lines.push(`    // Execute business logic`)
        if (isDependent) {
          lines.push(
            `    const item = await ${serviceCall}({ ...validated, ${this.getParentFkAssignment(schema)} })`
          )
        } else {
          lines.push(`    const item = await ${serviceCall}(validated)`)
        }
        lines.push('')
        lines.push(`    // Done.`)
        lines.push(`    return ctx.json(${className}Resource.make(item), 201)`)
        lines.push(`  }`)
        break
      }

      case 'update':
        lines.push(`  async update(ctx: Context) {`)
        if (isConfiguration) {
          guardNoResource()
          lines.push('')
          lines.push(`    // Validate user input`)
          lines.push(`    const body = await ctx.body<Record<string, unknown>>()`)
          lines.push(
            `    const { data: validated, errors } = validate(body, ${className}Rules.update!)`
          )
          lines.push(`    if (errors) return ctx.json({ errors }, 422)`)
          lines.push('')
          lines.push(`    // Execute business logic`)
          lines.push(`    const item = await this.service.upsert(ctx.params.parentId!, validated)`)
          lines.push('')
          lines.push(`    // Done.`)
          lines.push(`    return ctx.json(${className}Resource.make(item))`)
        } else {
          lines.push(`    const item = await this.service.find(ctx.params.id!)`)
          lines.push(`    if (!item) return ctx.json({ error: 'Not Found' }, 404)`)
          hasContentAbove = true
          if (policy?.withResource) {
            guardWithResource('item')
          }
          lines.push('')
          lines.push(`    // Validate user input`)
          lines.push(`    const body = await ctx.body<Record<string, unknown>>()`)
          lines.push(
            `    const { data: validated, errors } = validate(body, ${className}Rules.update!)`
          )
          lines.push(`    if (errors) return ctx.json({ errors }, 422)`)
          lines.push('')
          lines.push(`    // Execute business logic`)
          lines.push(`    const updated = await this.service.update(ctx.params.id!, validated)`)
          lines.push(`    if (!updated) return ctx.json({ error: 'Not Found' }, 404)`)
          lines.push('')
          lines.push(`    // Done.`)
          lines.push(`    return ctx.json(${className}Resource.make(updated))`)
        }
        lines.push(`  }`)
        break

      case 'destroy':
        lines.push(`  async destroy(ctx: Context) {`)
        if (isConfiguration) {
          guardNoResource()
          lines.push('')
          lines.push(`    // Execute business logic`)
          lines.push(`    const deleted = await this.service.reset(ctx.params.parentId!)`)
          lines.push(`    if (!deleted) return ctx.json({ error: 'Not Found' }, 404)`)
        } else {
          lines.push(`    const item = await this.service.find(ctx.params.id!)`)
          lines.push(`    if (!item) return ctx.json({ error: 'Not Found' }, 404)`)
          hasContentAbove = true
          if (policy?.withResource) {
            guardWithResource('item')
          }
          lines.push('')
          lines.push(`    // Execute business logic`)
          lines.push(`    const deleted = await this.service.delete(ctx.params.id!)`)
          lines.push(`    if (!deleted) return ctx.json({ error: 'Not Found' }, 404)`)
        }
        lines.push('')
        lines.push(`    // Done.`)
        lines.push(`    return ctx.json({ ok: true })`)
        lines.push(`  }`)
        break
    }

    return lines
  }

  // ---------------------------------------------------------------------------
  // 6. Resource
  // ---------------------------------------------------------------------------

  private generateResource(schema: SchemaDefinition, table: TableDefinition): GeneratedFile {
    const className = toPascalCase(schema.name)
    const snakeName = toSnakeCase(schema.name)
    const camelName = toCamelCase(schema.name)
    const modelImport = relativeImport(this.paths.resources, this.paths.models)

    const lines: string[] = [
      '// Generated by Strav — DO NOT EDIT',
      `import { Resource } from '@strav/http/http'`,
      `import type ${className} from '${modelImport}/${snakeName}'`,
      '',
      `export default class ${className}Resource extends Resource<${className}> {`,
      `  define(${camelName}: ${className}) {`,
      `    return {`,
    ]

    for (const col of table.columns) {
      if (col.name === 'deleted_at') continue
      if (col.sensitive) continue
      const propName = toCamelCase(col.name)
      lines.push(`      ${propName}: ${camelName}.${propName},`)
    }

    lines.push(`    }`)
    lines.push(`  }`)
    lines.push(`}`)
    lines.push('')

    return {
      path: join(this.paths.resources, `${snakeName}_resource.ts`),
      content: lines.join('\n'),
    }
  }

  /** Generate the parent FK assignment expression for dependent controllers. */
  private getParentFkAssignment(schema: SchemaDefinition): string {
    const routeParent = schema.parents?.[0]
    if (!routeParent) return ''
    const pkName = this.findSchemaPK(routeParent)
    const fkProp = toCamelCase(`${toSnakeCase(routeParent)}_${toSnakeCase(pkName)}`)
    return `${fkProp}: ctx.params.parentId!`
  }

  // ---------------------------------------------------------------------------
  // Barrel generation
  // ---------------------------------------------------------------------------

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
        const className = toPascalCase(basename)
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
  // Shared helpers
  // ---------------------------------------------------------------------------

  /** Find the primary key field name (camelCase) for a schema. Defaults to 'id'. */
  private findSchemaPK(schemaName: string): string {
    const schema = this.schemaMap.get(schemaName)
    if (!schema) return 'id'
    for (const [fieldName, fieldDef] of Object.entries(schema.fields)) {
      if (fieldDef.primaryKey) return fieldName
    }
    return 'id'
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
    const idx = enumName.lastIndexOf('_')
    return idx > 0 ? enumName.substring(0, idx) : enumName
  }
}

function isCustomType(pgType: unknown): pgType is PostgreSQLCustomType {
  return typeof pgType === 'object' && pgType !== null && (pgType as any).type === 'custom'
}
