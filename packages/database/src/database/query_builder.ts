import { DateTime } from 'luxon'
import { toSnakeCase } from '@strav/kernel/helpers/strings'
import type BaseModel from '../orm/base_model'
import { ModelNotFoundError } from '@strav/kernel/exceptions/errors'
import { getReferenceMeta, getAssociates, getCasts } from '../orm/decorators'
import type { ReferenceMetadata, AssociateMetadata, CastDefinition } from '../orm/decorators'
import { hydrateRow } from '../orm/base_model'
import Database from './database'

type ModelStatic<T extends BaseModel> = (new (...args: any[]) => T) & typeof BaseModel

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

export interface PaginationMeta {
  page: number
  perPage: number
  total: number
  lastPage: number
  from: number
  to: number
}

export interface PaginationResult<T> {
  data: T[]
  meta: PaginationMeta
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

type WhereBoolean = 'AND' | 'OR'

type WhereClause =
  | { kind: 'comparison'; column: string; operator: string; value: unknown; boolean: WhereBoolean }
  | { kind: 'in' | 'not_in'; column: string; values: unknown[]; boolean: WhereBoolean }
  | { kind: 'null' | 'not_null'; column: string; boolean: WhereBoolean }
  | { kind: 'between'; column: string; low: unknown; high: unknown; boolean: WhereBoolean }
  | { kind: 'raw'; sql: string; params: unknown[]; boolean: WhereBoolean }
  | { kind: 'group'; clauses: WhereClause[]; boolean: WhereBoolean }

interface JoinClause {
  type: 'LEFT JOIN' | 'INNER JOIN' | 'RIGHT JOIN'
  table: string
  alias: string
  leftCol: string
  operator: string
  rightCol: string
}

interface OrderByClause {
  column: string
  direction: 'ASC' | 'DESC'
}

// ---------------------------------------------------------------------------
// JoinBuilder
// ---------------------------------------------------------------------------

class JoinBuilder<T extends BaseModel> {
  constructor(
    private parent: QueryBuilder<T>,
    private model: typeof BaseModel,
    private joinType: 'LEFT JOIN' | 'INNER JOIN' | 'RIGHT JOIN'
  ) {}

  on(leftColumn: string, operator: string, rightColumn: string): QueryBuilder<T> {
    return this.parent._addJoin({
      type: this.joinType,
      table: this.model.tableName,
      alias: this.model.name,
      leftCol: leftColumn,
      operator,
      rightCol: rightColumn,
    })
  }
}

// ---------------------------------------------------------------------------
// QueryBuilder
// ---------------------------------------------------------------------------

export default class QueryBuilder<T extends BaseModel> {
  private modelClass: ModelStatic<T>
  private primaryTable: string
  private models: Map<string, typeof BaseModel> = new Map()
  private trx: any | null = null

  private wheres: WhereClause[] = []
  private havings: WhereClause[] = []
  private joins: JoinClause[] = []
  private orderBys: OrderByClause[] = []
  private groupBys: string[] = []
  private selectColumns: string[] = []
  private limitValue: number | null = null
  private offsetValue: number | null = null
  private isDistinct: boolean = false
  private includeTrashed: boolean = false
  private isOnlyTrashed: boolean = false
  private eagerLoads: string[] = []

  constructor(modelClass: ModelStatic<T>, trx?: any) {
    this.modelClass = modelClass
    this.primaryTable = modelClass.tableName
    this.models.set(modelClass.name, modelClass)
    this.trx = trx ?? null
  }

  /** The SQL connection — transaction if provided, otherwise the default pool. */
  private get connection() {
    // If we have a transaction, it should already be tenant-aware if needed
    if (this.trx) {
      return this.trx
    }

    // Use the tenant-aware SQL from the model's database
    return this.modelClass.db.sql
  }

  // ---------------------------------------------------------------------------
  // WHERE
  // ---------------------------------------------------------------------------

  where(
    column: string | ((q: QueryBuilder<T>) => void),
    operatorOrValue?: unknown,
    value?: unknown
  ): this {
    if (typeof column === 'function') {
      const sub = new QueryBuilder<T>(this.modelClass)
      column(sub)
      this.wheres.push({ kind: 'group', clauses: sub.wheres, boolean: 'AND' })
      return this
    }
    if (value === undefined) {
      this.wheres.push({
        kind: 'comparison',
        column,
        operator: '=',
        value: operatorOrValue,
        boolean: 'AND',
      })
    } else {
      this.wheres.push({
        kind: 'comparison',
        column,
        operator: operatorOrValue as string,
        value,
        boolean: 'AND',
      })
    }
    return this
  }

  whereIn(column: string, values: unknown[]): this {
    this.wheres.push({ kind: 'in', column, values, boolean: 'AND' })
    return this
  }

  whereNotIn(column: string, values: unknown[]): this {
    this.wheres.push({ kind: 'not_in', column, values, boolean: 'AND' })
    return this
  }

  whereNull(column: string): this {
    this.wheres.push({ kind: 'null', column, boolean: 'AND' })
    return this
  }

  whereNotNull(column: string): this {
    this.wheres.push({ kind: 'not_null', column, boolean: 'AND' })
    return this
  }

  whereBetween(column: string, low: unknown, high: unknown): this {
    this.wheres.push({ kind: 'between', column, low, high, boolean: 'AND' })
    return this
  }

  whereRaw(sql: string, params: unknown[] = []): this {
    this.wheres.push({ kind: 'raw', sql, params, boolean: 'AND' })
    return this
  }

  // ---------------------------------------------------------------------------
  // OR WHERE
  // ---------------------------------------------------------------------------

  orWhere(
    column: string | ((q: QueryBuilder<T>) => void),
    operatorOrValue?: unknown,
    value?: unknown
  ): this {
    if (typeof column === 'function') {
      const sub = new QueryBuilder<T>(this.modelClass)
      column(sub)
      this.wheres.push({ kind: 'group', clauses: sub.wheres, boolean: 'OR' })
      return this
    }
    if (value === undefined) {
      this.wheres.push({
        kind: 'comparison',
        column,
        operator: '=',
        value: operatorOrValue,
        boolean: 'OR',
      })
    } else {
      this.wheres.push({
        kind: 'comparison',
        column,
        operator: operatorOrValue as string,
        value,
        boolean: 'OR',
      })
    }
    return this
  }

  orWhereIn(column: string, values: unknown[]): this {
    this.wheres.push({ kind: 'in', column, values, boolean: 'OR' })
    return this
  }

  orWhereNotIn(column: string, values: unknown[]): this {
    this.wheres.push({ kind: 'not_in', column, values, boolean: 'OR' })
    return this
  }

  orWhereNull(column: string): this {
    this.wheres.push({ kind: 'null', column, boolean: 'OR' })
    return this
  }

  orWhereNotNull(column: string): this {
    this.wheres.push({ kind: 'not_null', column, boolean: 'OR' })
    return this
  }

  orWhereBetween(column: string, low: unknown, high: unknown): this {
    this.wheres.push({ kind: 'between', column, low, high, boolean: 'OR' })
    return this
  }

  orWhereRaw(sql: string, params: unknown[] = []): this {
    this.wheres.push({ kind: 'raw', sql, params, boolean: 'OR' })
    return this
  }

  // ---------------------------------------------------------------------------
  // HAVING
  // ---------------------------------------------------------------------------

  having(column: string, operatorOrValue: unknown, value?: unknown): this {
    if (value === undefined) {
      this.havings.push({
        kind: 'comparison',
        column,
        operator: '=',
        value: operatorOrValue,
        boolean: 'AND',
      })
    } else {
      this.havings.push({
        kind: 'comparison',
        column,
        operator: operatorOrValue as string,
        value,
        boolean: 'AND',
      })
    }
    return this
  }

  havingRaw(sql: string, params: unknown[] = []): this {
    this.havings.push({ kind: 'raw', sql, params, boolean: 'AND' })
    return this
  }

  // ---------------------------------------------------------------------------
  // JOIN
  // ---------------------------------------------------------------------------

  leftJoin(model: typeof BaseModel): JoinBuilder<T> {
    this.models.set(model.name, model)
    return new JoinBuilder(this, model, 'LEFT JOIN')
  }

  innerJoin(model: typeof BaseModel): JoinBuilder<T> {
    this.models.set(model.name, model)
    return new JoinBuilder(this, model, 'INNER JOIN')
  }

  rightJoin(model: typeof BaseModel): JoinBuilder<T> {
    this.models.set(model.name, model)
    return new JoinBuilder(this, model, 'RIGHT JOIN')
  }

  /** @internal Called by JoinBuilder to register a completed join. */
  _addJoin(join: JoinClause): this {
    this.joins.push(join)
    return this
  }

  // ---------------------------------------------------------------------------
  // SELECT, ORDER, GROUP, LIMIT, OFFSET
  // ---------------------------------------------------------------------------

  select(...columns: string[]): this {
    this.selectColumns.push(...columns)
    return this
  }

  orderBy(column: string, direction: 'asc' | 'desc' | 'ASC' | 'DESC' = 'ASC'): this {
    this.orderBys.push({ column, direction: direction.toUpperCase() as 'ASC' | 'DESC' })
    return this
  }

  groupBy(...columns: string[]): this {
    this.groupBys.push(...columns)
    return this
  }

  limit(n: number): this {
    this.limitValue = n
    return this
  }

  offset(n: number): this {
    this.offsetValue = n
    return this
  }

  distinct(): this {
    this.isDistinct = true
    return this
  }

  // ---------------------------------------------------------------------------
  // Soft deletes
  // ---------------------------------------------------------------------------

  withTrashed(): this {
    this.includeTrashed = true
    return this
  }

  onlyTrashed(): this {
    this.isOnlyTrashed = true
    return this
  }

  // ---------------------------------------------------------------------------
  // Eager loading
  // ---------------------------------------------------------------------------

  with(...relations: string[]): this {
    this.eagerLoads.push(...relations)
    return this
  }

  // ---------------------------------------------------------------------------
  // Scopes
  // ---------------------------------------------------------------------------

  scope(name: string): this {
    const scopes = (this.modelClass as any).scopes
    if (!scopes || typeof scopes[name] !== 'function') {
      throw new Error(`Unknown scope "${name}" on ${this.modelClass.name}`)
    }
    scopes[name](this)
    return this
  }

  // ---------------------------------------------------------------------------
  // Terminal methods — read
  // ---------------------------------------------------------------------------

  async all(): Promise<T[]> {
    const { sql, params } = this.build('select')
    const rows = await this.connection.unsafe(sql, params)
    const Model = this.modelClass as any
    const results = rows.map((row: Record<string, unknown>) => Model.hydrate(row) as T)
    await this.eagerLoad(results)
    return results
  }

  async first(): Promise<T | null> {
    const savedLimit = this.limitValue
    this.limitValue = 1
    const results = await this.all()
    this.limitValue = savedLimit
    return results[0] ?? null
  }

  async firstOrFail(): Promise<T> {
    const result = await this.first()
    if (!result) {
      throw new ModelNotFoundError(this.modelClass.name)
    }
    return result
  }

  async count(): Promise<number> {
    const { sql, params } = this.build('count')
    const rows = await this.connection.unsafe(sql, params)
    return Number(rows[0]?.count ?? 0)
  }

  async exists(): Promise<boolean> {
    return (await this.count()) > 0
  }

  async paginate(page: number = 1, perPage: number = 15): Promise<PaginationResult<T>> {
    const currentPage = Math.max(1, Math.floor(page))

    const total = await this.count()
    const lastPage = Math.max(1, Math.ceil(total / perPage))

    const savedLimit = this.limitValue
    const savedOffset = this.offsetValue
    this.limitValue = perPage
    this.offsetValue = (currentPage - 1) * perPage
    const data = await this.all()
    this.limitValue = savedLimit
    this.offsetValue = savedOffset

    const from = total > 0 ? (currentPage - 1) * perPage + 1 : 0
    const to = Math.min(currentPage * perPage, total)

    return {
      data,
      meta: { page: currentPage, perPage, total, lastPage, from, to },
    }
  }

  async pluck<V = unknown>(column: string): Promise<V[]> {
    const savedColumns = [...this.selectColumns]
    this.selectColumns = [column]
    const { sql, params } = this.build('select')
    this.selectColumns = savedColumns

    const rows = await this.connection.unsafe(sql, params)
    const snakeCol = toSnakeCase(column.includes('.') ? column.split('.')[1]! : column)
    return rows.map((row: Record<string, unknown>) => row[snakeCol] as V)
  }

  // ---------------------------------------------------------------------------
  // Terminal methods — aggregates
  // ---------------------------------------------------------------------------

  async sum(column: string): Promise<number> {
    return this.aggregate('SUM', column)
  }

  async avg(column: string): Promise<number> {
    return this.aggregate('AVG', column)
  }

  async min(column: string): Promise<number> {
    return this.aggregate('MIN', column)
  }

  async max(column: string): Promise<number> {
    return this.aggregate('MAX', column)
  }

  private async aggregate(fn: string, column: string): Promise<number> {
    const col = this.resolveColumn(column)
    const savedColumns = [...this.selectColumns]
    const savedDistinct = this.isDistinct
    this.selectColumns = [`${fn}(${col}) AS "result"`]
    this.isDistinct = false

    const { sql, params } = this.build('select')
    this.selectColumns = savedColumns
    this.isDistinct = savedDistinct

    const rows = await this.connection.unsafe(sql, params)
    return Number(rows[0]?.result ?? 0)
  }

  // ---------------------------------------------------------------------------
  // Terminal methods — mutations
  // ---------------------------------------------------------------------------

  async update(data: Record<string, unknown>): Promise<number> {
    const { sql, params } = this.buildUpdate(data)
    const result = await this.connection.unsafe(sql, params)
    return result.count
  }

  async delete(): Promise<number> {
    if (this.modelClass.softDeletes && !this.includeTrashed) {
      return this.update({ deletedAt: DateTime.now() })
    }
    const { sql, params } = this.buildDelete()
    const result = await this.connection.unsafe(sql, params)
    return result.count
  }

  async forceDelete(): Promise<number> {
    const { sql, params } = this.buildDelete()
    const result = await this.connection.unsafe(sql, params)
    return result.count
  }

  async increment(column: string, amount: number = 1): Promise<number> {
    return this.adjustColumn(column, amount)
  }

  async decrement(column: string, amount: number = 1): Promise<number> {
    return this.adjustColumn(column, -amount)
  }

  // ---------------------------------------------------------------------------
  // Terminal methods — iteration
  // ---------------------------------------------------------------------------

  async chunk(size: number, callback: (items: T[]) => Promise<void> | void): Promise<void> {
    let page = 0
    while (true) {
      const savedLimit = this.limitValue
      const savedOffset = this.offsetValue
      this.limitValue = size
      this.offsetValue = page * size
      const items = await this.all()
      this.limitValue = savedLimit
      this.offsetValue = savedOffset

      if (items.length === 0) break
      await callback(items)
      if (items.length < size) break
      page++
    }
  }

  /** Return the generated SQL and params without executing. */
  toSQL(): { sql: string; params: unknown[] } {
    return this.build('select')
  }

  // ---------------------------------------------------------------------------
  // SQL building — SELECT / COUNT
  // ---------------------------------------------------------------------------

  private build(mode: 'select' | 'count'): { sql: string; params: unknown[] } {
    const parts: string[] = []
    const params: unknown[] = []
    const paramIdx = { value: 1 }

    // SELECT
    if (mode === 'count') {
      parts.push('SELECT COUNT(*) AS "count"')
    } else if (this.selectColumns.length > 0) {
      const cols = this.selectColumns.map(c => this.resolveSelectColumn(c))
      parts.push(`SELECT ${this.isDistinct ? 'DISTINCT ' : ''}${cols.join(', ')}`)
    } else {
      parts.push(`SELECT ${this.isDistinct ? 'DISTINCT ' : ''}"${this.primaryTable}".*`)
    }

    // FROM
    parts.push(`FROM "${this.primaryTable}"`)

    // JOINs
    for (const join of this.joins) {
      const left = this.resolveColumn(join.leftCol)
      const right = this.resolveColumn(join.rightCol)
      parts.push(`${join.type} "${join.table}" ON ${left} ${join.operator} ${right}`)
    }

    // WHERE
    const { parts: whereParts, booleans: whereBooleans } = this.buildClauseParts(
      this.wheres,
      params,
      paramIdx,
      true
    )
    if (whereParts.length > 0) {
      parts.push(`WHERE ${this.joinWithBooleans(whereParts, whereBooleans)}`)
    }

    // GROUP BY
    if (this.groupBys.length > 0) {
      const cols = this.groupBys.map(c => this.resolveColumn(c))
      parts.push(`GROUP BY ${cols.join(', ')}`)
    }

    // HAVING
    if (this.havings.length > 0) {
      const { parts: havingParts, booleans: havingBooleans } = this.buildClauseParts(
        this.havings,
        params,
        paramIdx,
        false,
        true
      )
      if (havingParts.length > 0) {
        parts.push(`HAVING ${this.joinWithBooleans(havingParts, havingBooleans)}`)
      }
    }

    // count mode skips ORDER BY, LIMIT, OFFSET
    if (mode === 'select') {
      // ORDER BY
      if (this.orderBys.length > 0) {
        const clauses = this.orderBys.map(o => `${this.resolveColumn(o.column)} ${o.direction}`)
        parts.push(`ORDER BY ${clauses.join(', ')}`)
      }

      // LIMIT
      if (this.limitValue !== null) {
        parts.push(`LIMIT ${this.limitValue}`)
      }

      // OFFSET
      if (this.offsetValue !== null) {
        parts.push(`OFFSET ${this.offsetValue}`)
      }
    }

    return { sql: parts.join(' '), params }
  }

  // ---------------------------------------------------------------------------
  // SQL building — UPDATE / DELETE / INCREMENT
  // ---------------------------------------------------------------------------

  private buildUpdate(data: Record<string, unknown>): { sql: string; params: unknown[] } {
    const parts: string[] = []
    const params: unknown[] = []
    const paramIdx = { value: 1 }

    parts.push(`UPDATE "${this.primaryTable}"`)

    const setClauses: string[] = []
    for (const [key, val] of Object.entries(data)) {
      const col = toSnakeCase(key)
      params.push(this.dehydrateValue(val, key))
      setClauses.push(`"${col}" = $${paramIdx.value++}`)
    }
    parts.push(`SET ${setClauses.join(', ')}`)

    const { parts: whereParts, booleans: whereBooleans } = this.buildClauseParts(
      this.wheres,
      params,
      paramIdx,
      true
    )
    if (whereParts.length > 0) {
      parts.push(`WHERE ${this.joinWithBooleans(whereParts, whereBooleans)}`)
    }

    return { sql: parts.join(' '), params }
  }

  private buildDelete(): { sql: string; params: unknown[] } {
    const parts: string[] = []
    const params: unknown[] = []
    const paramIdx = { value: 1 }

    parts.push(`DELETE FROM "${this.primaryTable}"`)

    const { parts: whereParts, booleans: whereBooleans } = this.buildClauseParts(
      this.wheres,
      params,
      paramIdx,
      true
    )
    if (whereParts.length > 0) {
      parts.push(`WHERE ${this.joinWithBooleans(whereParts, whereBooleans)}`)
    }

    return { sql: parts.join(' '), params }
  }

  private async adjustColumn(column: string, amount: number): Promise<number> {
    const col = toSnakeCase(column)
    const parts: string[] = []
    const params: unknown[] = []
    const paramIdx = { value: 1 }

    parts.push(`UPDATE "${this.primaryTable}"`)
    params.push(Math.abs(amount))
    const op = amount >= 0 ? '+' : '-'
    parts.push(`SET "${col}" = "${col}" ${op} $${paramIdx.value++}`)

    const { parts: whereParts, booleans: whereBooleans } = this.buildClauseParts(
      this.wheres,
      params,
      paramIdx,
      true
    )
    if (whereParts.length > 0) {
      parts.push(`WHERE ${this.joinWithBooleans(whereParts, whereBooleans)}`)
    }

    const result = await this.connection.unsafe(parts.join(' '), params)
    return result.count
  }

  // ---------------------------------------------------------------------------
  // Shared clause building
  // ---------------------------------------------------------------------------

  private buildClauseParts(
    clauses: WhereClause[],
    params: unknown[],
    paramIdx: { value: number },
    includeSoftDeletes: boolean,
    rawColumns: boolean = false
  ): { parts: string[]; booleans: WhereBoolean[] } {
    const parts: string[] = []
    const booleans: WhereBoolean[] = []

    if (includeSoftDeletes && this.modelClass.softDeletes && !this.includeTrashed) {
      if (this.isOnlyTrashed) {
        parts.push(`"${this.primaryTable}"."deleted_at" IS NOT NULL`)
      } else {
        parts.push(`"${this.primaryTable}"."deleted_at" IS NULL`)
      }
      booleans.push('AND')
    }

    const resolve = rawColumns
      ? (ref: string) => this.resolveSelectColumn(ref)
      : (ref: string) => this.resolveColumn(ref)

    for (const w of clauses) {
      booleans.push(w.boolean)
      switch (w.kind) {
        case 'comparison': {
          const col = resolve(w.column)
          const prop = this.extractProperty(w.column)
          params.push(this.dehydrateValue(w.value, prop))
          parts.push(`${col} ${w.operator} $${paramIdx.value++}`)
          break
        }
        case 'in': {
          const col = resolve(w.column)
          const prop = this.extractProperty(w.column)
          const placeholders = w.values.map(v => {
            params.push(this.dehydrateValue(v, prop))
            return `$${paramIdx.value++}`
          })
          parts.push(`${col} IN (${placeholders.join(', ')})`)
          break
        }
        case 'not_in': {
          const col = resolve(w.column)
          const prop = this.extractProperty(w.column)
          const placeholders = w.values.map(v => {
            params.push(this.dehydrateValue(v, prop))
            return `$${paramIdx.value++}`
          })
          parts.push(`${col} NOT IN (${placeholders.join(', ')})`)
          break
        }
        case 'null': {
          const col = resolve(w.column)
          parts.push(`${col} IS NULL`)
          break
        }
        case 'not_null': {
          const col = resolve(w.column)
          parts.push(`${col} IS NOT NULL`)
          break
        }
        case 'between': {
          const col = resolve(w.column)
          const prop = this.extractProperty(w.column)
          params.push(this.dehydrateValue(w.low, prop))
          params.push(this.dehydrateValue(w.high, prop))
          parts.push(`${col} BETWEEN $${paramIdx.value++} AND $${paramIdx.value++}`)
          break
        }
        case 'raw': {
          let rawSql = w.sql
          for (const p of w.params) {
            rawSql = rawSql.replace(`$${w.params.indexOf(p) + 1}`, `$${paramIdx.value++}`)
            params.push(this.dehydrateValue(p))
          }
          parts.push(rawSql)
          break
        }
        case 'group': {
          const { parts: groupParts, booleans: groupBooleans } = this.buildClauseParts(
            w.clauses,
            params,
            paramIdx,
            false,
            rawColumns
          )
          if (groupParts.length > 0) {
            parts.push(`(${this.joinWithBooleans(groupParts, groupBooleans)})`)
          }
          break
        }
      }
    }

    return { parts, booleans }
  }

  private joinWithBooleans(parts: string[], booleans: WhereBoolean[]): string {
    if (parts.length === 0) return ''
    let result = parts[0]!
    for (let i = 1; i < parts.length; i++) {
      result += ` ${booleans[i]} ${parts[i]}`
    }
    return result
  }

  // ---------------------------------------------------------------------------
  // Eager loading
  // ---------------------------------------------------------------------------

  private async eagerLoad(models: T[]): Promise<void> {
    if (this.eagerLoads.length === 0 || models.length === 0) return

    const ctor = this.modelClass as unknown as Function
    const refMetas: ReferenceMetadata[] = getReferenceMeta(ctor)
    const assocMetas: AssociateMetadata[] = getAssociates(ctor)

    for (const relation of this.eagerLoads) {
      const refMeta = refMetas.find(r => r.property === relation)
      if (refMeta) {
        await this.eagerLoadReference(models, refMeta)
        continue
      }

      const assocMeta = assocMetas.find(a => a.property === relation)
      if (assocMeta) {
        await this.eagerLoadAssociation(models, assocMeta)
        continue
      }

      throw new Error(`Unknown relation "${relation}" on ${this.modelClass.name}`)
    }
  }

  private async eagerLoadReference(models: T[], meta: ReferenceMetadata): Promise<void> {
    const fkValues = [
      ...new Set(
        models.map(m => (m as any)[meta.foreignKey]).filter(v => v !== null && v !== undefined)
      ),
    ]

    if (fkValues.length === 0) {
      for (const model of models) {
        ;(model as any)[meta.property] = null
      }
      return
    }

    const targetTable = toSnakeCase(meta.model)
    const targetPKCol = toSnakeCase(meta.targetPK)
    const placeholders = fkValues.map((_, i) => `$${i + 1}`).join(', ')
    const rows = await this.connection.unsafe(
      `SELECT * FROM "${targetTable}" WHERE "${targetPKCol}" IN (${placeholders})`,
      fkValues
    )

    const lookup = new Map<unknown, Record<string, unknown>>()
    for (const row of rows) {
      const r = row as Record<string, unknown>
      lookup.set(r[targetPKCol], hydrateRow(r))
    }

    for (const model of models) {
      const fkVal = (model as any)[meta.foreignKey]
      ;(model as any)[meta.property] = fkVal != null ? (lookup.get(fkVal) ?? null) : null
    }
  }

  private async eagerLoadAssociation(models: T[], meta: AssociateMetadata): Promise<void> {
    const ctor = this.modelClass as typeof BaseModel
    const pkProp = ctor.primaryKeyProperty

    const pkValues = models.map(m => (m as any)[pkProp])
    if (pkValues.length === 0) return

    const targetTable = toSnakeCase(meta.model)
    const targetPKCol = toSnakeCase(meta.targetPK)
    const placeholders = pkValues.map((_, i) => `$${i + 1}`).join(', ')

    const rows = await this.connection.unsafe(
      `SELECT t.*, p."${meta.foreignKey}" AS "_pivot_fk" ` +
        `FROM "${targetTable}" t ` +
        `INNER JOIN "${meta.through}" p ON p."${meta.otherKey}" = t."${targetPKCol}" ` +
        `WHERE p."${meta.foreignKey}" IN (${placeholders})`,
      pkValues
    )

    const grouped = new Map<unknown, Record<string, unknown>[]>()
    for (const row of rows) {
      const r = row as Record<string, unknown>
      const fk = r._pivot_fk
      delete r._pivot_fk
      if (!grouped.has(fk)) grouped.set(fk, [])
      grouped.get(fk)!.push(hydrateRow(r))
    }

    for (const model of models) {
      const pk = (model as any)[pkProp]
      ;(model as any)[meta.property] = grouped.get(pk) ?? []
    }
  }

  // ---------------------------------------------------------------------------
  // Column resolution
  // ---------------------------------------------------------------------------

  /**
   * Resolve a user column reference to a fully qualified SQL identifier.
   *
   * - `'email'`            → `"user"."email"`
   * - `'User.email'`       → `"user"."email"`
   * - `'Project.userId'`   → `"project"."user_id"`
   */
  private resolveColumn(ref: string): string {
    const dot = ref.indexOf('.')
    if (dot === -1) {
      return `"${this.primaryTable}"."${toSnakeCase(ref)}"`
    }

    const modelName = ref.substring(0, dot)
    const propName = ref.substring(dot + 1)
    const tableName = this.resolveModelTable(modelName)
    return `"${tableName}"."${toSnakeCase(propName)}"`
  }

  /**
   * Resolve a select column. Passes through raw expressions containing
   * special characters (parentheses, asterisk, AS keyword).
   */
  private resolveSelectColumn(col: string): string {
    if (/[(*)]/.test(col) || /\bAS\b/i.test(col)) {
      return col
    }
    return this.resolveColumn(col)
  }

  /** Resolve a PascalCase model name to its table name. */
  private resolveModelTable(modelName: string): string {
    const model = this.models.get(modelName)
    if (model) return model.tableName
    return toSnakeCase(modelName)
  }

  // ---------------------------------------------------------------------------
  // Value helpers
  // ---------------------------------------------------------------------------

  private dehydrateValue(value: unknown, property?: string): unknown {
    if (value == null) return value

    if (property) {
      const castDef = this.castMap.get(property)
      if (castDef) return castDef.set(value)
    }

    if (this.isLuxonDateTime(value)) return value.toJSDate()
    return value
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

  private get castMap(): Map<string, CastDefinition> {
    return getCasts(this.modelClass)
  }

  /** Extract the property name from a column reference (e.g. 'users.email' → 'email'). */
  private extractProperty(column: string): string {
    const dotIdx = column.lastIndexOf('.')
    return dotIdx >= 0 ? column.slice(dotIdx + 1) : column
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Create a new QueryBuilder for the given model class.
 *
 * @example
 * const users = await query(User).where('email', 'test@example.com').all()
 *
 * // Inside a transaction:
 * await transaction(async (trx) => {
 *   const user = await query(User, trx).where('id', 1).first()
 * })
 */
export function query<T extends BaseModel>(model: ModelStatic<T>, trx?: any): QueryBuilder<T> {
  return new QueryBuilder<T>(model, trx)
}

/**
 * Run a callback inside a database transaction.
 *
 * The transaction automatically commits on success and rolls back on error.
 * In multi-tenant mode the underlying `Database.raw` getter routes through
 * a tenant-aware proxy that injects `set_config('app.tenant_id', ...)` as
 * the first statement of the transaction, so RLS policies see the active
 * tenant for every query inside the callback.
 *
 * @example
 * const user = await transaction(async (trx) => {
 *   const u = await User.create({ name: 'Alice' }, trx)
 *   await Profile.create({ userId: u.id }, trx)
 *   return u
 * })
 *
 * @example
 * // In multi-tenant context
 * await withTenant('a3b1c4d5-...', async () => {
 *   await transaction(async (trx) => {
 *     await User.create({ name: 'Bob' }, trx)
 *   })
 * })
 */
export async function transaction<T>(fn: (trx: any) => Promise<T>): Promise<T> {
  return Database.raw.begin((trx: any) => fn(trx))
}
