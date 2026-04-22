import { UnsupportedFilterError } from '../errors.ts'
import { quoteIdent } from '../engine/schema.ts'

export interface CompiledFilter {
  /** SQL fragment to splice into a WHERE clause (no leading 'WHERE'). Empty if no filter. */
  sql: string
  /** Bound parameters in the order their `?` placeholders appear. */
  params: unknown[]
}

/**
 * Compile a filter object into a parameterized SQL WHERE fragment.
 *
 * Supported value shapes for each key:
 * - primitive (string/number/boolean/null) → `key = ?`
 * - array of primitives → `key IN (?, ?, ?)`
 * - operator object: `{ gt, gte, lt, lte, eq, neq, in }` → composed clauses
 *
 * Unknown keys are NOT validated against the field registry here — callers
 * are expected to have configured `filterableAttributes` correctly. SQLite
 * raises a clean error if the column doesn't exist.
 */
export function compileFilter(
  filter: Record<string, unknown> | string | undefined,
  filterableAttributes: ReadonlySet<string>
): CompiledFilter {
  if (!filter) return { sql: '', params: [] }

  if (typeof filter === 'string') {
    throw new UnsupportedFilterError(
      'Raw string filters are not supported by the embedded driver. ' +
        'Pass an object like `{ status: "published" }` instead.'
    )
  }

  const clauses: string[] = []
  const params: unknown[] = []

  for (const [key, value] of Object.entries(filter)) {
    if (value === undefined) continue

    if (!filterableAttributes.has(key)) {
      throw new UnsupportedFilterError(
        `Field "${key}" is not in filterableAttributes. ` +
          'Add it to the index settings before filtering on it.'
      )
    }

    const col = quoteIdent(key)

    if (value === null) {
      clauses.push(`${col} IS NULL`)
      continue
    }

    if (Array.isArray(value)) {
      if (value.length === 0) {
        clauses.push('1 = 0')
      } else {
        const placeholders = value.map(() => '?').join(', ')
        clauses.push(`${col} IN (${placeholders})`)
        params.push(...value.map(coerce))
      }
      continue
    }

    if (isOperatorObject(value)) {
      for (const [op, opValue] of Object.entries(value)) {
        const compiled = compileOperator(col, op, opValue)
        clauses.push(compiled.sql)
        params.push(...compiled.params)
      }
      continue
    }

    if (isPrimitive(value)) {
      clauses.push(`${col} = ?`)
      params.push(coerce(value))
      continue
    }

    throw new UnsupportedFilterError(
      `Unsupported filter value for key "${key}": ${JSON.stringify(value)}`
    )
  }

  return { sql: clauses.join(' AND '), params }
}

function isOperatorObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  return Object.keys(value).every(k => OPERATORS.has(k))
}

const OPERATORS = new Set(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'in', 'nin'])

function compileOperator(col: string, op: string, value: unknown): CompiledFilter {
  switch (op) {
    case 'eq':
      return { sql: `${col} = ?`, params: [coerce(value)] }
    case 'neq':
      return { sql: `${col} <> ?`, params: [coerce(value)] }
    case 'gt':
      return { sql: `${col} > ?`, params: [coerce(value)] }
    case 'gte':
      return { sql: `${col} >= ?`, params: [coerce(value)] }
    case 'lt':
      return { sql: `${col} < ?`, params: [coerce(value)] }
    case 'lte':
      return { sql: `${col} <= ?`, params: [coerce(value)] }
    case 'in': {
      if (!Array.isArray(value) || value.length === 0) return { sql: '1 = 0', params: [] }
      const ph = value.map(() => '?').join(', ')
      return { sql: `${col} IN (${ph})`, params: value.map(coerce) }
    }
    case 'nin': {
      if (!Array.isArray(value) || value.length === 0) return { sql: '1 = 1', params: [] }
      const ph = value.map(() => '?').join(', ')
      return { sql: `${col} NOT IN (${ph})`, params: value.map(coerce) }
    }
    default:
      throw new UnsupportedFilterError(`Unknown operator "${op}"`)
  }
}

function isPrimitive(value: unknown): boolean {
  return (
    typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
  )
}

function coerce(value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean') return value ? 1 : 0
  return value
}
