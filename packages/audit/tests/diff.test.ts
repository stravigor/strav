import { describe, expect, test } from 'bun:test'
import { diff, jsonEqual } from '../src/diff.ts'

describe('diff', () => {
  test('returns empty diff for equal primitives', () => {
    expect(diff(1, 1)).toEqual({})
    expect(diff('a', 'a')).toEqual({})
    expect(diff(null, null)).toEqual({})
  })

  test('records value-level change for non-objects', () => {
    expect(diff(1, 2)).toEqual({ changed: { value: { before: 1, after: 2 } } })
    expect(diff('a', 'b')).toEqual({ changed: { value: { before: 'a', after: 'b' } } })
  })

  test('detects added top-level keys', () => {
    expect(diff({ a: 1 }, { a: 1, b: 2 })).toEqual({ added: { b: 2 } })
  })

  test('detects removed top-level keys', () => {
    expect(diff({ a: 1, b: 2 }, { a: 1 })).toEqual({ removed: { b: 2 } })
  })

  test('detects changed top-level keys with before/after', () => {
    expect(diff({ name: 'A' }, { name: 'B' })).toEqual({
      changed: { name: { before: 'A', after: 'B' } },
    })
  })

  test('treats undefined → value as added (not changed)', () => {
    expect(diff({ a: undefined }, { a: 1 })).toEqual({ added: { a: 1 } })
    expect(diff({ a: 1 }, { a: undefined })).toEqual({ removed: { a: 1 } })
  })

  test('null is a real value distinct from undefined', () => {
    expect(diff({ a: null }, { a: 1 })).toEqual({
      changed: { a: { before: null, after: 1 } },
    })
  })

  test('combines added, removed, and changed in one call', () => {
    const before = { name: 'A', score: 10, removed: true }
    const after = { name: 'B', score: 10, added: 'new' }
    expect(diff(before, after)).toEqual({
      added: { added: 'new' },
      removed: { removed: true },
      changed: { name: { before: 'A', after: 'B' } },
    })
  })

  test('treats nested objects via JSON equality', () => {
    expect(diff({ tags: ['a', 'b'] }, { tags: ['a', 'b'] })).toEqual({})
    expect(diff({ tags: ['a', 'b'] }, { tags: ['a', 'c'] })).toEqual({
      changed: { tags: { before: ['a', 'b'], after: ['a', 'c'] } },
    })
  })

  test('handles Date instances by JSON equality', () => {
    const a = new Date('2026-01-01T00:00:00Z')
    const b = new Date('2026-01-01T00:00:00Z')
    expect(jsonEqual(a, b)).toBe(true)
  })
})
