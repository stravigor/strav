import { describe, test, expect } from 'bun:test'
import { formatNumber } from '../src/objects/number.ts'
import { encodeName } from '../src/objects/name.ts'
import { encodeLiteral, encodeHex, textString, dateString } from '../src/objects/string.ts'
import { encodeObject } from '../src/objects/encode.ts'
import { arr, bool, dict, name, num, ref } from '../src/objects/types.ts'
import { PdfGenError } from '../src/util/errors.ts'

const dec = (b: Uint8Array) => new TextDecoder('latin1').decode(b)

describe('number formatting (§5.1)', () => {
  test('integers have no decimal point', () => {
    expect(formatNumber(0)).toBe('0')
    expect(formatNumber(-42)).toBe('-42')
    expect(formatNumber(1000000)).toBe('1000000')
  })

  test('reals: ≤6 decimals, trailing zeros stripped, no exponent', () => {
    expect(formatNumber(0.5)).toBe('0.5')
    expect(formatNumber(1.1)).toBe('1.1')
    expect(formatNumber(141.73228346)).toBe('141.732283')
    expect(formatNumber(0.0000001)).toBe('0') // rounds below 6dp
    expect(formatNumber(1e-7)).not.toContain('e')
  })

  test('Infinity / NaN / -0 throw', () => {
    expect(() => formatNumber(Infinity)).toThrow(PdfGenError)
    expect(() => formatNumber(NaN)).toThrow(PdfGenError)
    expect(() => formatNumber(-0)).toThrow(PdfGenError)
  })
})

describe('name escaping (§5.1)', () => {
  test('plain names pass through with leading slash', () => {
    expect(dec(encodeName('Type'))).toBe('/Type')
  })
  test('delimiters, spaces, # and high bytes are #XX escaped', () => {
    expect(dec(encodeName('A B'))).toBe('/A#20B')
    expect(dec(encodeName('a#b'))).toBe('/a#23b')
    expect(dec(encodeName('paired()'))).toBe('/paired#28#29')
  })
})

describe('strings (§5.1)', () => {
  test('literal escaping of backslash and parens', () => {
    expect(dec(encodeLiteral(new TextEncoder().encode('a(b)\\c')))).toBe('(a\\(b\\)\\\\c)')
  })
  test('hex string', () => {
    expect(dec(encodeHex(Uint8Array.from([0xde, 0xad])))).toBe('<DEAD>')
  })
  test('text string defaults to UTF-16BE with BOM (hex serialized)', () => {
    const s = textString('A')
    expect(s.encoding).toBe('hex')
    expect(dec(encodeObject(s))).toBe('<FEFF0041>')
  })
  test('pdfdoc encoding stays single-byte literal', () => {
    const s = textString('AB', { encoding: 'pdfdoc' })
    expect(dec(encodeObject(s))).toBe('(AB)')
  })
  test('date string format', () => {
    const s = dateString(new Date(Date.UTC(2026, 4, 18, 9, 30, 0)))
    expect(dec(s.value)).toBe("D:20260518093000+00'00'")
  })
})

describe('object encoder (§5.1)', () => {
  test('primitives', () => {
    expect(dec(encodeObject(bool(true)))).toBe('true')
    expect(dec(encodeObject(num(3.14)))).toBe('3.14')
    expect(dec(encodeObject(ref(7, 0)))).toBe('7 0 R')
    expect(dec(encodeObject(name('Foo')))).toBe('/Foo')
  })
  test('array spacing', () => {
    expect(dec(encodeObject(arr([num(1), num(2), name('X')])))).toBe('[1 2 /X]')
  })
  test('dictionary preserves insertion order', () => {
    const d = dict({ B: num(2), A: num(1) })
    expect(dec(encodeObject(d))).toBe('<</B 2 /A 1 >>')
  })
  test('stream sets /Length to data byte length', () => {
    const data = new TextEncoder().encode('hello')
    const s = encodeObject({ kind: 'stream', dict: dict({}), data })
    expect(dec(s)).toBe('<</Length 5 >>\nstream\nhello\nendstream')
  })
})
