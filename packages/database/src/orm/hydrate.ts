import { DateTime } from 'luxon'
import { toCamelCase } from '@strav/kernel/helpers/strings'

/** Convert a raw DB row to a plain object with camelCase keys and DateTime hydration. */
export function hydrateRow(row: Record<string, unknown>): Record<string, unknown> {
  const obj: Record<string, unknown> = {}
  for (const [column, value] of Object.entries(row)) {
    const prop = toCamelCase(column)
    obj[prop] = value instanceof Date ? DateTime.fromJSDate(value) : value
  }
  return obj
}
