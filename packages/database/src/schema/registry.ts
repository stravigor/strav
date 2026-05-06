import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { SchemaDefinition } from './types'
import type { DatabaseRepresentation } from './database_representation'
import RepresentationBuilder from './representation_builder'
import {
  type TenantIdType,
  DEFAULT_TENANT_ID_TYPE,
  setTenantIdType,
  tenantIdTypeFromPgType,
} from '../database/tenant/id_type'
import { setTenantTableName, tenantFkColumnFor } from '../database/tenant/naming'

/**
 * Discovers, stores, validates, and provides dependency-ordered
 * access to all schema definitions in the application.
 *
 * @example
 * const registry = new SchemaRegistry()
 * await registry.discover('database/schemas')
 * registry.validate()
 * const ordered = registry.resolve() // topologically sorted
 */
export default class SchemaRegistry {
  private schemas = new Map<string, SchemaDefinition>()
  private _tenantSchema: SchemaDefinition | null = null

  /** Register a single schema definition. */
  register(schema: SchemaDefinition): this {
    if (this.schemas.has(schema.name)) {
      throw new Error(`Schema "${schema.name}" is already registered`)
    }
    if (schema.tenantRegistry) {
      if (this._tenantSchema) {
        throw new Error(
          `Cannot register tenant registry schema "${schema.name}": "${this._tenantSchema.name}" is already marked tenantRegistry: true. Only one is allowed.`
        )
      }
      this._tenantSchema = schema
      // Propagate to module state so Database / SqlGenerator / RepresentationBuilder
      // can read the configured tenant table name and idType without going
      // through the registry.
      this.applyTenantSchema(schema)
    }
    this.schemas.set(schema.name, schema)
    return this
  }

  /** The schema marked `tenantRegistry: true`, or `null` if none registered. */
  tenantSchema(): SchemaDefinition | null {
    return this._tenantSchema
  }

  /** The tenant table name from the registered tenant schema, or `null`. */
  tenantTableName(): string | null {
    return this._tenantSchema?.name ?? null
  }

  /** Derive the runtime tenant id type from the registered tenant schema's PK. */
  tenantIdType(): TenantIdType | null {
    if (!this._tenantSchema) return null
    const pkField = Object.values(this._tenantSchema.fields).find(f => f.primaryKey)
    if (!pkField || typeof pkField.pgType !== 'string') return null
    return tenantIdTypeFromPgType(pkField.pgType)
  }

  /**
   * Push tenant schema info into module state so Database getters and
   * downstream generators can read the configured names without holding a
   * reference to this registry.
   */
  private applyTenantSchema(schema: SchemaDefinition): void {
    setTenantTableName(schema.name)
    const idType = this.tenantIdTypeFromSchema(schema)
    if (idType) setTenantIdType(idType)
  }

  private tenantIdTypeFromSchema(schema: SchemaDefinition): TenantIdType | null {
    const pkField = Object.values(schema.fields).find(f => f.primaryKey)
    if (!pkField || typeof pkField.pgType !== 'string') return null
    return tenantIdTypeFromPgType(pkField.pgType)
  }

  /** Retrieve a schema by name. */
  get(name: string): SchemaDefinition | undefined {
    return this.schemas.get(name)
  }

  /** Check whether a schema with the given name exists. */
  has(name: string): boolean {
    return this.schemas.has(name)
  }

  /** Return all registered schemas as an array. */
  all(): SchemaDefinition[] {
    return Array.from(this.schemas.values())
  }

  /**
   * Scan a directory for schema files and register all discovered schemas.
   * Each `.ts` file must default-export a {@link SchemaDefinition}.
   */
  async discover(schemasPath: string): Promise<void> {
    const basePath = resolve(schemasPath)

    let files: string[]
    try {
      files = readdirSync(basePath)
    } catch {
      throw new Error(`Schemas directory not found: ${schemasPath}`)
    }

    for (const file of files) {
      if (!file.endsWith('.ts')) continue
      const filePath = join(basePath, file)
      const mod = await import(filePath)
      const schema: SchemaDefinition = mod.default
      if (!schema || !schema.name) {
        throw new Error(`Schema file "${file}" does not export a valid SchemaDefinition`)
      }
      this.register(schema)
    }
  }

  /**
   * Validate all schemas: check that every reference and parent
   * points to a registered schema.
   */
  validate(): void {
    // If any schema is tenant-scoped, exactly one tenantRegistry schema
    // must be registered. The framework-injected `<tenantTableName>_id` FK
    // would otherwise reference a non-existent table.
    const hasTenantedChild = Array.from(this.schemas.values()).some(s => s.tenanted)
    if (hasTenantedChild && !this._tenantSchema) {
      throw new Error(
        `One or more schemas are marked tenanted: true but no tenant registry schema is registered. ` +
          `Add a defineSchema(...) with tenantRegistry: true (or import @strav/database/schemas/default_tenant).`
      )
    }

    for (const schema of this.schemas.values()) {
      if (schema.parents) {
        for (const parent of schema.parents) {
          if (!this.schemas.has(parent)) {
            throw new Error(
              `Schema "${schema.name}" references parent "${parent}" which is not registered`
            )
          }
        }
      }

      if (schema.associates) {
        for (const assoc of schema.associates) {
          if (!this.schemas.has(assoc)) {
            throw new Error(
              `Schema "${schema.name}" associates with "${assoc}" which is not registered`
            )
          }
        }
      }

      for (const [fieldName, fieldDef] of Object.entries(schema.fields)) {
        if (fieldDef.references && !this.schemas.has(fieldDef.references)) {
          throw new Error(
            `Schema "${schema.name}" field "${fieldName}" references "${fieldDef.references}" which is not registered`
          )
        }
      }
    }
  }

  /**
   * Return schemas in dependency order (topological sort).
   * Schemas with no dependencies come first.
   * Throws if a circular dependency is detected.
   */
  resolve(): SchemaDefinition[] {
    const visited = new Set<string>()
    const visiting = new Set<string>()
    const sorted: SchemaDefinition[] = []

    const visit = (name: string, path: string[]) => {
      if (visited.has(name)) return
      if (visiting.has(name)) {
        throw new Error(`Circular dependency detected: ${[...path, name].join(' -> ')}`)
      }

      visiting.add(name)
      const schema = this.schemas.get(name)!
      for (const dep of this.getDependencies(schema)) {
        visit(dep, [...path, name])
      }
      visiting.delete(name)
      visited.add(name)
      sorted.push(schema)
    }

    for (const name of this.schemas.keys()) {
      visit(name, [])
    }

    return sorted
  }

  /**
   * Generate the {@link DatabaseRepresentation} from all registered schemas.
   * Must be called after {@link validate} to ensure all references are resolvable.
   *
   * Tenant table name and id type default to whatever was registered via
   * `tenantRegistry: true`. Callers may override (rare — only useful for
   * generating migrations against a different tenant configuration than the
   * current process).
   */
  buildRepresentation(
    tenantIdType?: TenantIdType,
    tenantTableName?: string,
    tenantFkColumn?: string
  ): DatabaseRepresentation {
    const ordered = this.resolve()
    const idType = tenantIdType ?? this.tenantIdType() ?? DEFAULT_TENANT_ID_TYPE
    const tableName = tenantTableName ?? this.tenantTableName() ?? undefined
    const fkColumn =
      tenantFkColumn ?? (tableName ? tenantFkColumnFor(tableName) : undefined)
    return new RepresentationBuilder(ordered, idType, tableName, fkColumn).build()
  }

  /** Collect all schema names that the given schema depends on, excluding self-references. */
  private getDependencies(schema: SchemaDefinition): string[] {
    const deps = new Set<string>()

    if (schema.parents) {
      for (const parent of schema.parents) {
        // Exclude self-references to allow hierarchical structures
        if (parent !== schema.name) {
          deps.add(parent)
        }
      }
    }
    if (schema.associates) {
      for (const assoc of schema.associates) {
        // Exclude self-references for self-associations
        if (assoc !== schema.name) {
          deps.add(assoc)
        }
      }
    }
    for (const fieldDef of Object.values(schema.fields)) {
      if (fieldDef.references) {
        // Exclude self-references to allow parent-child relationships
        if (fieldDef.references !== schema.name) {
          deps.add(fieldDef.references)
        }
      }
    }

    return Array.from(deps)
  }
}
