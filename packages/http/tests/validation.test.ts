import { describe, test, expect } from 'bun:test'
import {
  validate,
  required,
  string,
  integer,
  number,
  boolean,
  min,
  max,
} from '../src/validation/index.ts'

describe('validate() — coercion', () => {
  test('integer() coerces numeric strings into numbers', () => {
    const result = validate<{ position: number }>(
      { position: '5' },
      { position: [integer()] }
    )
    expect(result.errors).toBeNull()
    expect(result.data.position).toBe(5)
    expect(typeof result.data.position).toBe('number')
  })

  test('integer() coerces "0" (the original bug)', () => {
    const result = validate<{ position: number }>(
      { position: '0' },
      { position: [integer()] }
    )
    expect(result.errors).toBeNull()
    expect(result.data.position).toBe(0)
  })

  test('integer() rejects fractional strings as non-integer', () => {
    const result = validate({ position: '5.5' }, { position: [integer()] })
    expect(result.errors?.position).toEqual(['Must be an integer'])
  })

  test('integer() rejects non-numeric strings', () => {
    const result = validate({ position: 'abc' }, { position: [integer()] })
    expect(result.errors?.position).toEqual(['Must be an integer'])
  })

  test('integer() leaves empty string for required() to own', () => {
    const optional = validate({ position: '' }, { position: [integer()] })
    expect(optional.errors).toBeNull()

    const requiredField = validate(
      { position: '' },
      { position: [required(), integer()] }
    )
    expect(requiredField.errors?.position).toEqual(['This field is required'])
  })

  test('integer() preserves already-typed numbers', () => {
    const result = validate<{ position: number }>(
      { position: 7 },
      { position: [integer()] }
    )
    expect(result.errors).toBeNull()
    expect(result.data.position).toBe(7)
  })

  test('number() coerces decimal strings', () => {
    const result = validate<{ price: number }>(
      { price: '19.99' },
      { price: [number()] }
    )
    expect(result.errors).toBeNull()
    expect(result.data.price).toBe(19.99)
  })

  test('number() rejects non-numeric strings', () => {
    const result = validate({ price: 'free' }, { price: [number()] })
    expect(result.errors?.price).toEqual(['Must be a number'])
  })

  test('boolean() coerces common truthy strings', () => {
    for (const input of ['true', 'TRUE', '1', 'on', 'On']) {
      const result = validate<{ active: boolean }>(
        { active: input },
        { active: [boolean()] }
      )
      expect(result.errors).toBeNull()
      expect(result.data.active).toBe(true)
    }
  })

  test('boolean() coerces common falsy strings', () => {
    for (const input of ['false', 'FALSE', '0', 'off', 'Off']) {
      const result = validate<{ active: boolean }>(
        { active: input },
        { active: [boolean()] }
      )
      expect(result.errors).toBeNull()
      expect(result.data.active).toBe(false)
    }
  })

  test('boolean() rejects ambiguous strings', () => {
    const result = validate({ active: 'maybe' }, { active: [boolean()] })
    expect(result.errors?.active).toEqual(['Must be a boolean'])
  })

  test('coerced value is fed to subsequent rules in the chain', () => {
    // After integer() coerces "5" to 5, min(10) sees a number and rejects it.
    const result = validate(
      { position: '5' },
      { position: [integer(), min(10)] }
    )
    expect(result.errors?.position).toEqual(['Must be at least 10'])
  })

  test('coerced value passes downstream numeric checks', () => {
    const result = validate<{ position: number }>(
      { position: '15' },
      { position: [integer(), min(10), max(20)] }
    )
    expect(result.errors).toBeNull()
    expect(result.data.position).toBe(15)
  })

  test('rules without coerce still behave as before', () => {
    const result = validate({ name: 123 }, { name: [string()] })
    expect(result.errors?.name).toEqual(['Must be a string'])
  })

  test('end-to-end: full form body with mixed types', () => {
    // Simulates what ctx.body() returns for an HTML form POST.
    const formBody = {
      title: 'Buy milk',
      position: '3',
      priority: '1.5',
      done: 'on',
    }
    const result = validate<{
      title: string
      position: number
      priority: number
      done: boolean
    }>(formBody, {
      title: [required(), string()],
      position: [required(), integer()],
      priority: [required(), number()],
      done: [boolean()],
    })

    expect(result.errors).toBeNull()
    expect(result.data).toEqual({
      title: 'Buy milk',
      position: 3,
      priority: 1.5,
      done: true,
    })
  })

  test('undefined fields are not coerced and not added to data', () => {
    const result = validate(
      {},
      { position: [integer()] } // optional, absent
    )
    expect(result.errors).toBeNull()
    expect('position' in result.data).toBe(false)
  })
})
