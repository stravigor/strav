import { describe, test, expect } from 'bun:test'
import { Lexer } from '../src/reader/lexer.ts'
import { parseObjectFrom } from '../src/reader/object_parser.ts'
import { isDict, isArr, isNum, isStr, isName, isRef } from '../src/objects/types.ts'

const lex = (s: string) => new Lexer(new TextEncoder().encode(s), 0)
const txt = (b: Uint8Array) => new TextDecoder('latin1').decode(b)

describe('Lexer (§7.2)', () => {
  test('numbers: integer, real, signed, leading dot', () => {
    const l = lex('0 34.5 -.002 +12 4.')
    expect(l.next()).toEqual({ type: 'num', value: 0 })
    expect(l.next()).toEqual({ type: 'num', value: 34.5 })
    expect(l.next()).toEqual({ type: 'num', value: -0.002 })
    expect(l.next()).toEqual({ type: 'num', value: 12 })
    expect(l.next()).toEqual({ type: 'num', value: 4 })
  })

  test('name with #XX hex escape', () => {
    const t = lex('/Pa#20me').next()
    expect(t).toEqual({ type: 'name', value: 'Pa me' })
  })

  test('literal string: escapes, octal, balanced parens, line continuation', () => {
    const t = lex('(a\\(b\\)\\101\\n line\\\ncont)').next()
    expect(t.type).toBe('str')
    if (t.type === 'str') expect(txt(t.value)).toBe('a(b)A\n linecont')
  })

  test('hex string, odd nibble padded', () => {
    const t = lex('<48656c6c6F7>').next()
    expect(t.type).toBe('str')
    if (t.type === 'str') expect(txt(t.value)).toBe('Hello\x70')
  })

  test('comments and CRLF are skipped', () => {
    const l = lex('% a comment\r\n  42 %trailing')
    expect(l.next()).toEqual({ type: 'num', value: 42 })
  })

  test('dictionary and array delimiters', () => {
    const l = lex('<< /A [1 2] >>')
    expect(l.next()).toEqual({ type: 'delim', value: '<<' })
    expect(l.next()).toEqual({ type: 'name', value: 'A' })
    expect(l.next()).toEqual({ type: 'delim', value: '[' })
  })
})

describe('ObjectParser (§7.3)', () => {
  test('parses a dictionary with nested ref and array', () => {
    const o = parseObjectFrom(new TextEncoder().encode('<< /Type /Page /Kids [4 0 R] /N 3 >>'))
    expect(isDict(o)).toBe(true)
    if (isDict(o)) {
      const ty = o.entries.get('Type')!
      expect(isName(ty) && ty.value).toBe('Page')
      const kids = o.entries.get('Kids')!
      expect(isArr(kids)).toBe(true)
      if (isArr(kids)) expect(isRef(kids.items[0]!)).toBe(true)
      const n = o.entries.get('N')!
      expect(isNum(n) && n.value).toBe(3)
    }
  })

  test('distinguishes "1 2 R" reference from two numbers', () => {
    const ref = parseObjectFrom(new TextEncoder().encode('1 2 R'))
    expect(isRef(ref)).toBe(true)
    const arr = parseObjectFrom(new TextEncoder().encode('[1 2]'))
    expect(isArr(arr)).toBe(true)
  })

  test('parses a stream, slicing by /Length', () => {
    const body = 'Hello stream'
    const src = `<< /Length ${body.length} >>\nstream\n${body}\nendstream`
    const o = parseObjectFrom(new TextEncoder().encode(src))
    expect(o.kind).toBe('stream')
    if (o.kind === 'stream') expect(txt(o.data)).toBe(body)
  })

  test('falls back to scan when /Length is wrong', () => {
    const body = 'payload bytes here'
    const src = `<< /Length 3 >>\nstream\n${body}\nendstream`
    const o = parseObjectFrom(new TextEncoder().encode(src))
    expect(o.kind).toBe('stream')
    if (o.kind === 'stream') expect(txt(o.data)).toBe(body)
  })
})
