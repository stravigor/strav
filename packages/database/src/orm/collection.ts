import { toCamelCase, toSnakeCase } from '@strav/kernel/helpers/strings'
import { DatabaseError } from '@strav/kernel/exceptions/errors'
import type { AssociateMetadata } from './decorators'
import type BaseModel from './base_model'
import { hydrateRow } from './hydrate'
import { hasTenantContext, isBypassingTenant } from '../database/tenant/context'

export type AttachTarget = BaseModel | string | number | bigint

/**
 * Per-instance accessor for a `@associate` (many-to-many) relationship.
 *
 * Iterates the loaded rows once `load()` (or eager-load via `query()`) has
 * populated them, and provides write-side helpers (`attach`, `detach`, `sync`)
 * that operate against the pivot table.
 *
 * Loaded rows are plain camelCase objects (mirroring the prior eager-load
 * behavior); they are not full hydrated `BaseModel` instances.
 */
export default class Collection<T extends BaseModel = BaseModel> {
  private items: Record<string, unknown>[] = []
  private _loaded = false

  constructor(
    private readonly parent: BaseModel,
    private readonly meta: AssociateMetadata
  ) {}

  // ---------------------------------------------------------------------------
  // Array-like access
  // ---------------------------------------------------------------------------

  get length(): number {
    return this.items.length
  }

  isLoaded(): boolean {
    return this._loaded
  }

  [Symbol.iterator](): IterableIterator<T> {
    return this.items[Symbol.iterator]() as unknown as IterableIterator<T>
  }

  toArray(): T[] {
    return [...this.items] as unknown as T[]
  }

  at(index: number): T | undefined {
    return this.items.at(index) as unknown as T | undefined
  }

  // ---------------------------------------------------------------------------
  // Hydration (used by load() and the query builder eager loader)
  // ---------------------------------------------------------------------------

  /** @internal */
  hydrate(rows: Record<string, unknown>[]): void {
    this.items = rows.map(r => hydrateRow(r))
    this._loaded = true
  }

  // ---------------------------------------------------------------------------
  // load
  // ---------------------------------------------------------------------------

  async load(trx?: any): Promise<this> {
    const ctor = this.parent.constructor as typeof BaseModel
    const conn = trx ?? ctor.db.sql
    const pkValue = (this.parent as any)[ctor.primaryKeyProperty]

    const targetTable = toSnakeCase(this.meta.model)
    const targetPKCol = toSnakeCase(this.meta.targetPK)

    const rows = await conn.unsafe(
      `SELECT t.* FROM "${targetTable}" t ` +
        `INNER JOIN "${this.meta.through}" p ON p."${this.meta.otherKey}" = t."${targetPKCol}" ` +
        `WHERE p."${this.meta.foreignKey}" = $1`,
      [pkValue]
    )

    this.hydrate(rows as Record<string, unknown>[])
    return this
  }

  // ---------------------------------------------------------------------------
  // attach
  // ---------------------------------------------------------------------------

  async attach(
    target: AttachTarget | AttachTarget[],
    extras?: Record<string, unknown>,
    trx?: any
  ): Promise<this> {
    const ctor = this.parent.constructor as typeof BaseModel
    this.assertTenantContext(ctor, 'attach')

    const ids = this.extractIds(target)
    if (ids.length === 0) return this

    const conn = trx ?? ctor.db.sql
    const pkValue = (this.parent as any)[ctor.primaryKeyProperty]

    const extraEntries = extras ? Object.entries(extras) : []
    const extraCols = extraEntries.map(([k]) => toSnakeCase(k))
    const extraVals = extraEntries.map(([, v]) => v)

    const allCols = [this.meta.foreignKey, this.meta.otherKey, ...extraCols]
    const colsSql = allCols.map(c => `"${c}"`).join(', ')

    const params: unknown[] = []
    const rowSql: string[] = []
    let p = 1
    for (const id of ids) {
      const placeholders: string[] = []
      placeholders.push(`$${p++}`)
      params.push(pkValue)
      placeholders.push(`$${p++}`)
      params.push(id)
      for (const v of extraVals) {
        placeholders.push(`$${p++}`)
        params.push(v)
      }
      rowSql.push(`(${placeholders.join(', ')})`)
    }

    await conn.unsafe(
      `INSERT INTO "${this.meta.through}" (${colsSql}) VALUES ${rowSql.join(', ')} ` +
        `ON CONFLICT DO NOTHING`,
      params
    )
    return this
  }

  // ---------------------------------------------------------------------------
  // detach
  // ---------------------------------------------------------------------------

  async detach(target?: AttachTarget | AttachTarget[], trx?: any): Promise<this> {
    const ctor = this.parent.constructor as typeof BaseModel
    this.assertTenantContext(ctor, 'detach')

    const conn = trx ?? ctor.db.sql
    const pkValue = (this.parent as any)[ctor.primaryKeyProperty]

    if (target === undefined) {
      await conn.unsafe(
        `DELETE FROM "${this.meta.through}" WHERE "${this.meta.foreignKey}" = $1`,
        [pkValue]
      )
      return this
    }

    const ids = this.extractIds(target)
    if (ids.length === 0) return this

    const placeholders = ids.map((_, i) => `$${i + 2}`).join(', ')
    await conn.unsafe(
      `DELETE FROM "${this.meta.through}" WHERE "${this.meta.foreignKey}" = $1 ` +
        `AND "${this.meta.otherKey}" IN (${placeholders})`,
      [pkValue, ...ids]
    )
    return this
  }

  // ---------------------------------------------------------------------------
  // sync
  // ---------------------------------------------------------------------------

  async sync(
    targets: AttachTarget[],
    extras?: Record<string, unknown>,
    trx?: any
  ): Promise<this> {
    const ctor = this.parent.constructor as typeof BaseModel
    this.assertTenantContext(ctor, 'sync')

    const run = async (conn: any) => {
      await this.detach(undefined, conn)
      if (targets.length > 0) {
        await this.attach(targets, extras, conn)
      }
    }

    if (trx) {
      await run(trx)
    } else {
      await ctor.db.sql.begin(async (tx: any) => {
        await run(tx)
      })
    }
    return this
  }

  // ---------------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------------

  private extractIds(target: AttachTarget | AttachTarget[]): unknown[] {
    const targetPKProp = toCamelCase(this.meta.targetPK)
    const arr = Array.isArray(target) ? target : [target]
    return arr.map(t => {
      if (t === null || t === undefined) {
        throw new DatabaseError(
          `Cannot attach/detach a null or undefined target on ${this.meta.through}.`
        )
      }
      if (typeof t === 'object') {
        const id = (t as any)[targetPKProp]
        if (id === undefined || id === null) {
          throw new DatabaseError(
            `Target instance has no value for primary key "${targetPKProp}". ` +
              `Save the target before attaching to ${this.meta.through}.`
          )
        }
        return id
      }
      return t
    })
  }

  private assertTenantContext(ctor: typeof BaseModel, op: string): void {
    if (
      ctor.tenantScoped &&
      ctor.db.isMultiTenant &&
      !hasTenantContext() &&
      !isBypassingTenant()
    ) {
      throw new DatabaseError(
        `${ctor.name}.${this.meta.property}.${op}() requires withTenant(...) or withoutTenant(...).`
      )
    }
  }
}
