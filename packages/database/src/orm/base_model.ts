import { DateTime } from 'luxon'
import { toSnakeCase, toCamelCase } from '@strav/kernel/helpers/strings'
import { ulid as generateUlid } from '@strav/kernel/helpers'
import { inject } from '@strav/kernel/core/inject'
import {
  getPrimaryKey,
  getReferences,
  getReferenceMeta,
  getAssociates,
  getCasts,
  getEncrypted,
  getUlids,
} from './decorators'
import type { ReferenceMetadata, AssociateMetadata } from './decorators'
import Database from '../database/database'
import { hasTenantContext, isBypassingTenant } from '../database/tenant/context'
import {
  ConfigurationError,
  DatabaseError,
  ModelNotFoundError,
} from '@strav/kernel/exceptions/errors'

type ModelStatic<T extends BaseModel> = (new (...args: any[]) => T) & typeof BaseModel

@inject
export default class BaseModel {
  private static _db: Database

  /** Whether this model supports soft deletes. Override in subclass. */
  static softDeletes: boolean = false

  /**
   * Whether this model's table is tenant-scoped. When true and
   * `database.tenant.enabled` is on, the table carries a `tenant_id`
   * column and an RLS policy. Inserts/updates outside a `withTenant(...)`
   * or `withoutTenant(...)` block are rejected.
   */
  static tenantScoped: boolean = false

  /**
   * Property name to use when calling `model.load('<name>')` to fetch the
   * parent tenant row. Defaults to `db.tenantTableName` (e.g. `'workspace'`
   * when the configured table is `workspace`, or `'tenant'` for the default).
   * Override on a per-model basis to use a different accessor name.
   */
  static tenantRef: string | undefined = undefined

  constructor(db?: Database) {
    if (db) BaseModel._db = db
  }

  /** The underlying database connection. */
  static get db(): Database {
    if (!BaseModel._db) {
      throw new ConfigurationError(
        'Database not configured. Resolve BaseModel through the container first.'
      )
    }
    return BaseModel._db
  }

  /** Derive table name from class name: User → user, OrderItem → order_item */
  static get tableName(): string {
    return toSnakeCase(this.name)
  }

  /** The primary key column name in snake_case (from @primary metadata). */
  static get primaryKeyColumn(): string {
    return toSnakeCase(getPrimaryKey(this))
  }

  /** The primary key property name in camelCase (from @primary metadata). */
  static get primaryKeyProperty(): string {
    return getPrimaryKey(this)
  }

  /** Whether this record was loaded from (or saved to) the database. */
  _exists: boolean = false

  // ---------------------------------------------------------------------------
  // Static CRUD
  // ---------------------------------------------------------------------------

  /** Find a record by primary key. Returns null if not found or soft-deleted. */
  static async find<T extends BaseModel>(
    this: ModelStatic<T>,
    id: number | string | bigint
  ): Promise<T | null> {
    BaseModel.assertTenantContextFor(this)
    const db = BaseModel.db
    const table = this.tableName
    const pkCol = this.primaryKeyColumn
    const softClause = this.softDeletes ? ' AND "deleted_at" IS NULL' : ''
    const rows = await db.sql.unsafe(
      `SELECT * FROM "${table}" WHERE "${pkCol}" = $1${softClause} LIMIT 1`,
      [id]
    )
    if (rows.length === 0) return null
    return this.hydrate<T>(rows[0] as Record<string, unknown>)
  }

  /**
   * Throw if a tenant-scoped model is queried by id without an active tenant
   * context. Without it, `find(1)` could return any tenant's row 1
   * non-deterministically.
   */
  private static assertTenantContextFor(model: typeof BaseModel): void {
    if (
      model.tenantScoped &&
      BaseModel.db.isMultiTenant &&
      !hasTenantContext() &&
      !isBypassingTenant()
    ) {
      throw new DatabaseError(
        `${model.name} is tenant-scoped; wrap find() in withTenant(...) or withoutTenant(...).`
      )
    }
  }

  /** Find a record by primary key or throw. */
  static async findOrFail<T extends BaseModel>(
    this: ModelStatic<T>,
    id: number | string | bigint
  ): Promise<T> {
    const result = (await (this as any).find(id)) as T | null
    if (!result) {
      throw new ModelNotFoundError(this.name, id)
    }
    return result
  }

  /** Retrieve all records (excluding soft-deleted). */
  static async all<T extends BaseModel>(this: ModelStatic<T>): Promise<T[]> {
    const db = BaseModel.db
    const table = this.tableName
    const softClause = this.softDeletes ? ' WHERE "deleted_at" IS NULL' : ''
    const rows = await db.sql.unsafe(`SELECT * FROM "${table}"${softClause}`)
    return rows.map((row: Record<string, unknown>) => this.hydrate<T>(row))
  }

  /** Create a new record, assign attributes, save, and return it. */
  static async create<T extends BaseModel>(
    this: ModelStatic<T>,
    attrs: Record<string, unknown>,
    trx?: any
  ): Promise<T> {
    const instance = new this()
    instance.merge(attrs)
    await instance.save(trx)
    return instance
  }

  // ---------------------------------------------------------------------------
  // Instance helpers
  // ---------------------------------------------------------------------------

  /** Assign properties from a plain object onto this model instance. */
  merge(data: Record<string, unknown>): this {
    for (const [key, value] of Object.entries(data)) {
      ;(this as any)[key] = value
    }
    return this
  }

  /**
   * Serialize this model for JSON.stringify() (Vue islands, API responses, etc.).
   * Skips internal (_-prefixed), @reference, and @associate properties.
   * Converts DateTime to ISO strings. Leaves @cast-parsed values as-is.
   */
  toJSON(): Record<string, unknown> {
    const ctor = this.constructor as typeof BaseModel
    const refProps = new Set(getReferences(ctor))
    const assocProps = new Set(getAssociates(ctor).map(a => a.property))
    const encryptedProps = new Set(getEncrypted(ctor))
    const result: Record<string, unknown> = {}

    for (const key of Object.keys(this)) {
      if (key.startsWith('_')) continue
      if (refProps.has(key)) continue
      if (assocProps.has(key)) continue
      if (encryptedProps.has(key)) continue

      const value = (this as any)[key]
      if (this.isLuxonDateTime(value)) {
        result[key] = value.toISO()
      } else if (typeof value === 'bigint') {
        result[key] =
          value <= Number.MAX_SAFE_INTEGER && value >= Number.MIN_SAFE_INTEGER
            ? Number(value)
            : String(value)
      } else {
        result[key] = value
      }
    }

    return result
  }

  // ---------------------------------------------------------------------------
  // Instance CRUD
  // ---------------------------------------------------------------------------

  /** INSERT or UPDATE depending on whether the record exists. */
  async save(trx?: any): Promise<this> {
    const ctor = this.constructor as typeof BaseModel

    if (
      ctor.tenantScoped &&
      BaseModel.db.isMultiTenant &&
      !hasTenantContext() &&
      !isBypassingTenant()
    ) {
      throw new DatabaseError(
        `${ctor.name} is tenant-scoped; wrap save() in withTenant(...) or withoutTenant(...).`
      )
    }

    const conn = trx ?? BaseModel.db.sql
    const table = ctor.tableName

    if (this._exists) {
      return this.performUpdate(conn, table)
    } else {
      return this.performInsert(conn, table)
    }
  }

  /** Soft-delete (if model supports it) or hard-delete. */
  async delete(trx?: any): Promise<void> {
    const ctor = this.constructor as typeof BaseModel
    const conn = trx ?? BaseModel.db.sql
    const table = ctor.tableName
    const pkCol = ctor.primaryKeyColumn
    const pkProp = ctor.primaryKeyProperty
    const pkValue = (this as any)[pkProp]

    if (ctor.softDeletes && (this as any).deletedAt === null) {
      const now = DateTime.now()
      ;(this as any).deletedAt = now
      await conn.unsafe(`UPDATE "${table}" SET "deleted_at" = $1 WHERE "${pkCol}" = $2`, [
        now.toJSDate(),
        pkValue,
      ])
    } else {
      await conn.unsafe(`DELETE FROM "${table}" WHERE "${pkCol}" = $1`, [pkValue])
      this._exists = false
    }
  }

  /** Always hard-delete, regardless of soft-delete support. */
  async forceDelete(trx?: any): Promise<void> {
    const conn = trx ?? BaseModel.db.sql
    const ctor = this.constructor as typeof BaseModel
    const table = ctor.tableName
    const pkCol = ctor.primaryKeyColumn
    const pkProp = ctor.primaryKeyProperty
    const pkValue = (this as any)[pkProp]
    await conn.unsafe(`DELETE FROM "${table}" WHERE "${pkCol}" = $1`, [pkValue])
    this._exists = false
  }

  // ---------------------------------------------------------------------------
  // Relationship loading
  // ---------------------------------------------------------------------------

  /**
   * Eagerly load one or more relationships by name.
   *
   * Supports both `@reference` (belongs-to) and `@associate` (many-to-many)
   * relationships. Returns `this` for chaining.
   *
   * @example
   * const team = await Team.find(1)
   * await team.load('members')          // many-to-many
   * await user.load('profile', 'teams') // multiple relations
   */
  async load(...relations: string[]): Promise<this> {
    const ctor = this.constructor as typeof BaseModel
    const refMetas = getReferenceMeta(ctor)
    const assocMetas = getAssociates(ctor)
    const tenantRef = ctor.tenantScoped
      ? (ctor.tenantRef ?? BaseModel.db.tenantTableName)
      : undefined

    for (const relation of relations) {
      const refMeta = refMetas.find(r => r.property === relation)
      if (refMeta) {
        await this.loadReference(refMeta)
        continue
      }

      const assocMeta = assocMetas.find(a => a.property === relation)
      if (assocMeta) {
        await this.loadAssociation(assocMeta)
        continue
      }

      if (tenantRef && relation === tenantRef) {
        await this.loadTenant(relation)
        continue
      }

      throw new Error(`Unknown relation "${relation}" on ${ctor.name}`)
    }

    return this
  }

  /**
   * Load the parent tenant row from the configured tenant table. Reads the
   * tenant FK from the model's `<tenantTableName>Id` property (camelCase) and
   * routes through `db.bypass` since the tenant table is global (no RLS).
   */
  private async loadTenant(property: string): Promise<void> {
    const db = BaseModel.db
    const fkProp = toCamelCase(db.tenantFkColumn)
    const fkValue = (this as any)[fkProp]

    if (fkValue === null || fkValue === undefined) {
      ;(this as any)[property] = null
      return
    }

    const rows = await db.bypass.unsafe(
      `SELECT * FROM "${db.tenantTableName}" WHERE "id" = $1 LIMIT 1`,
      [fkValue]
    )

    ;(this as any)[property] =
      rows.length > 0 ? hydrateRow(rows[0] as Record<string, unknown>) : null
  }

  private async loadReference(meta: ReferenceMetadata): Promise<void> {
    const db = BaseModel.db
    const fkValue = (this as any)[meta.foreignKey]

    if (fkValue === null || fkValue === undefined) {
      ;(this as any)[meta.property] = null
      return
    }

    const targetTable = toSnakeCase(meta.model)
    const targetPKCol = toSnakeCase(meta.targetPK)
    const rows = await db.sql.unsafe(
      `SELECT * FROM "${targetTable}" WHERE "${targetPKCol}" = $1 LIMIT 1`,
      [fkValue]
    )

    ;(this as any)[meta.property] =
      rows.length > 0 ? hydrateRow(rows[0] as Record<string, unknown>) : null
  }

  private async loadAssociation(meta: AssociateMetadata): Promise<void> {
    const db = BaseModel.db
    const ctor = this.constructor as typeof BaseModel
    const pkValue = (this as any)[ctor.primaryKeyProperty]

    const targetTable = toSnakeCase(meta.model)
    const rows = await db.sql.unsafe(
      `SELECT t.* FROM "${targetTable}" t ` +
        `INNER JOIN "${meta.through}" p ON p."${meta.otherKey}" = t."${toSnakeCase(meta.targetPK)}" ` +
        `WHERE p."${meta.foreignKey}" = $1`,
      [pkValue]
    )

    ;(this as any)[meta.property] = (rows as Record<string, unknown>[]).map(row => hydrateRow(row))
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async performInsert(conn: any, table: string): Promise<this> {
    // Auto-generate ULIDs for fields marked with @ulid decorator
    const ctor = this.constructor as typeof BaseModel
    const ulidFields = getUlids(ctor)
    for (const field of ulidFields) {
      const snakeField = toSnakeCase(field)
      if (!(this as any)[field]) {
        (this as any)[field] = generateUlid()
      }
    }

    const data = this.dehydrate()
    const columns = Object.keys(data)
    const values = Object.values(data)

    let sql: string
    if (columns.length === 0) {
      sql = `INSERT INTO "${table}" DEFAULT VALUES RETURNING *`
    } else {
      const colNames = columns.map(c => `"${c}"`).join(', ')
      const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ')
      sql = `INSERT INTO "${table}" (${colNames}) VALUES (${placeholders}) RETURNING *`
    }

    const rows = await conn.unsafe(sql, values)

    if (rows.length > 0) {
      this.hydrateFrom(rows[0] as Record<string, unknown>)
    }

    this._exists = true
    return this
  }

  private async performUpdate(conn: any, table: string): Promise<this> {
    if ('updatedAt' in this) (this as any).updatedAt = DateTime.now()

    const ctor = this.constructor as typeof BaseModel
    const pkCol = ctor.primaryKeyColumn

    const data = this.dehydrate()
    const pkValue = data[pkCol]
    delete data[pkCol]

    const columns = Object.keys(data)
    const values = Object.values(data)
    const setClauses = columns.map((col, i) => `"${col}" = $${i + 1}`).join(', ')
    values.push(pkValue)

    await conn.unsafe(
      `UPDATE "${table}" SET ${setClauses} WHERE "${pkCol}" = $${values.length}`,
      values
    )

    return this
  }

  /**
   * Convert a DB row to a model instance.
   * snake_case columns → camelCase properties. Date → DateTime.
   */
  /** @internal Used by QueryBuilder to create model instances from DB rows. */
  static hydrate<T extends BaseModel>(this: new () => T, row: Record<string, unknown>): T {
    const instance = new this()
    instance.hydrateFrom(row)
    instance._exists = true
    return instance
  }

  /** Populate this instance's properties from a DB row. */
  private hydrateFrom(row: Record<string, unknown>): void {
    const casts = getCasts(this.constructor as typeof BaseModel)

    for (const [column, value] of Object.entries(row)) {
      const prop = toCamelCase(column)

      if (value == null) {
        ;(this as any)[prop] = value
        continue
      }

      if (value instanceof Date) {
        ;(this as any)[prop] = DateTime.fromJSDate(value)
      } else {
        const castDef = casts.get(prop)
        if (castDef) {
          ;(this as any)[prop] = castDef.get(value)
        } else {
          ;(this as any)[prop] = value
        }
      }
    }
  }

  /**
   * Robust check for Luxon DateTime objects that works across different class instances.
   * Uses duck-typing instead of instanceof to avoid module resolution issues.
   */
  private isLuxonDateTime(value: any): value is DateTime {
    return value &&
           typeof value === 'object' &&
           typeof value.toJSDate === 'function' &&
           typeof value.toISO === 'function' &&
           value.constructor.name === 'DateTime'
  }

  /**
   * Convert model properties to DB columns.
   * Skips _-prefixed props and @reference-decorated properties.
   */
  private dehydrate(): Record<string, unknown> {
    const ctor = this.constructor as typeof BaseModel
    const refProps = new Set(getReferences(ctor))
    const assocProps = new Set(getAssociates(ctor).map(a => a.property))
    const casts = getCasts(ctor)
    const data: Record<string, unknown> = {}

    for (const key of Object.keys(this)) {
      if (key.startsWith('_')) continue
      if (refProps.has(key)) continue
      if (assocProps.has(key)) continue

      const value = (this as any)[key]
      const column = toSnakeCase(key)

      if (value == null) {
        data[column] = value
        continue
      }

      if (this.isLuxonDateTime(value)) {
        data[column] = value.toJSDate()
      } else {
        const castDef = casts.get(key)
        if (castDef) {
          data[column] = castDef.set(value)
        } else {
          data[column] = value
        }
      }
    }

    return data
  }
}

/** Convert a raw DB row to a plain object with camelCase keys and DateTime hydration. */
export function hydrateRow(row: Record<string, unknown>): Record<string, unknown> {
  const obj: Record<string, unknown> = {}
  for (const [column, value] of Object.entries(row)) {
    const prop = toCamelCase(column)
    obj[prop] = value instanceof Date ? DateTime.fromJSDate(value) : value
  }
  return obj
}
