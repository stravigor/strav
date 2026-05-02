import type { AuditDiff } from './types.ts'

/**
 * Shallow / one-level-nested structural diff suitable for audit logs.
 *
 * - Top-level keys present only on the right become `added`.
 * - Top-level keys present only on the left become `removed`.
 * - Top-level keys present on both with non-equal values become `changed`,
 *   recording `{ before, after }`.
 * - Equality uses JSON-stringify comparison — handles nested objects, arrays,
 *   and primitives without needing a deep-equal dependency, at the cost of
 *   key-order sensitivity inside nested values. Acceptable for audit payloads
 *   that come from the same source on both sides.
 *
 * `null` and `undefined` are treated as the same "absent" state for `added`/
 * `removed` semantics: a key going from `undefined` to a value is `added`,
 * not `changed`.
 *
 * @example
 * diff({ name: 'A', score: 10 }, { name: 'B', score: 10, status: 'qualified' })
 * // → { changed: { name: { before: 'A', after: 'B' } }, added: { status: 'qualified' } }
 */
export function diff(before: unknown, after: unknown): AuditDiff {
  if (!isPlainObject(before) || !isPlainObject(after)) {
    if (jsonEqual(before, after)) return {}
    return { changed: { value: { before, after } } }
  }

  const result: AuditDiff = {}
  const added: Record<string, unknown> = {}
  const removed: Record<string, unknown> = {}
  const changed: Record<string, { before: unknown; after: unknown }> = {}

  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  for (const key of keys) {
    const left = (before as Record<string, unknown>)[key]
    const right = (after as Record<string, unknown>)[key]

    const leftAbsent = left === undefined
    const rightAbsent = right === undefined

    if (leftAbsent && !rightAbsent) {
      added[key] = right
    } else if (!leftAbsent && rightAbsent) {
      removed[key] = left
    } else if (!jsonEqual(left, right)) {
      changed[key] = { before: left, after: right }
    }
  }

  if (Object.keys(added).length > 0) result.added = added
  if (Object.keys(removed).length > 0) result.removed = removed
  if (Object.keys(changed).length > 0) result.changed = changed
  return result
}

/** True if two values are equal under JSON-stringify normalization. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  return JSON.stringify(a) === JSON.stringify(b)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false
  if (Array.isArray(value)) return false
  if (value instanceof Date) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}
