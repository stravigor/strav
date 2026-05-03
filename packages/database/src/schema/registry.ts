import { readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { SchemaDefinition } from './types'
import type { DatabaseRepresentation } from './database_representation'
import RepresentationBuilder from './representation_builder'

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

  /** Register a single schema definition. */
  register(schema: SchemaDefinition): this {
    if (this.schemas.has(schema.name)) {
      throw new Error(`Schema "${schema.name}" is already registered`)
    }
    this.schemas.set(schema.name, schema)
    return this
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
   */
  buildRepresentation(): DatabaseRepresentation {
    const ordered = this.resolve()
    return new RepresentationBuilder(ordered).build()
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
