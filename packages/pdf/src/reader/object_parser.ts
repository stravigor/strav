/**
 * Recursive-descent parser: token stream → {@link PdfObject} (spec §7.3).
 *
 * Handles the two-number lookahead for indirect references (`n g R`) and
 * indirect object bodies (`n g obj … endobj`), including `stream`/`endstream`
 * whose raw bytes are sliced by the resolved `/Length` (with a scan-to-
 * `endstream` fallback for the wrong/indirect lengths real files contain).
 */

import {
  type PdfObject,
  type PdfDictionary,
  bool,
  num,
  name,
  arr,
  ref,
  dict as makeDict,
  NULL,
  isNum,
  isDict,
} from '../objects/types.ts'
import { PdfParseError } from '../util/errors.ts'
import { Lexer, latin1, type Token } from './lexer.ts'

/** Resolve an object to a plain number (for indirect `/Length`). */
export type LengthResolver = (o: PdfObject) => number | undefined

export class ObjectParser {
  constructor(
    readonly lex: Lexer,
    private readonly resolveLength?: LengthResolver,
  ) {}

  /** Parse the indirect object whose body starts at `offset`. */
  parseIndirectAt(offset: number): { num: number; gen: number; value: PdfObject } {
    this.lex.seek(offset)
    const n = this.lex.next()
    const g = this.lex.next()
    const obj = this.lex.next()
    if (n.type !== 'num' || g.type !== 'num' || obj.type !== 'kw' || obj.value !== 'obj') {
      throw new PdfParseError(`Expected "N G obj" at offset ${offset}`)
    }
    const value = this.parseObject()
    return { num: n.value, gen: g.value, value }
  }

  /** Parse a single object value, resolving `n g R` / streams. */
  parseObject(): PdfObject {
    const t = this.lex.next()
    return this.parseFromToken(t)
  }

  private parseFromToken(t: Token): PdfObject {
    switch (t.type) {
      case 'eof':
        throw new PdfParseError('Unexpected end of input')
      case 'num':
        return this.parseNumberOrRef(t.value)
      case 'str':
        return { kind: 'str', value: t.value, encoding: t.encoding }
      case 'name':
        return name(t.value)
      case 'kw':
        if (t.value === 'true') return bool(true)
        if (t.value === 'false') return bool(false)
        if (t.value === 'null') return NULL
        // Unknown bare keyword (e.g. "endobj", "R" out of place) — treat as null
        return NULL
      case 'delim':
        if (t.value === '[') return this.parseArray()
        if (t.value === '<<') return this.parseDictOrStream()
        throw new PdfParseError(`Unexpected token "${t.value}"`)
    }
  }

  private parseNumberOrRef(first: number): PdfObject {
    // Lookahead for `int int R` (indirect reference).
    const save = this.lex.pos
    const t2 = this.lex.next()
    if (t2.type === 'num' && Number.isInteger(first) && Number.isInteger(t2.value)) {
      const t3 = this.lex.next()
      if (t3.type === 'kw' && t3.value === 'R') {
        return ref(first, t2.value)
      }
    }
    this.lex.pos = save
    return num(first)
  }

  private parseArray(): PdfObject {
    const items: PdfObject[] = []
    for (;;) {
      const t = this.lex.next()
      if (t.type === 'eof') throw new PdfParseError('Unterminated array')
      if (t.type === 'delim' && t.value === ']') break
      items.push(this.parseFromToken(t))
    }
    return arr(items)
  }

  private parseDictOrStream(): PdfObject {
    const d = makeDict()
    for (;;) {
      const t = this.lex.next()
      if (t.type === 'eof') throw new PdfParseError('Unterminated dictionary')
      if (t.type === 'delim' && t.value === '>>') break
      if (t.type !== 'name') {
        // tolerate garbage keys by skipping a value
        continue
      }
      const value = this.parseObject()
      d.entries.set(t.value, value)
    }
    // A `stream` keyword immediately following the dict makes this a stream.
    const save = this.lex.pos
    this.lex.skipWs()
    if (this.matchKeyword('stream')) {
      return this.readStreamBody(d)
    }
    this.lex.pos = save
    return d
  }

  private matchKeyword(kw: string): boolean {
    const b = this.lex.buf
    let p = this.lex.pos
    for (let i = 0; i < kw.length; i++) {
      if (b[p + i] !== kw.charCodeAt(i)) return false
    }
    p += kw.length
    this.lex.pos = p
    return true
  }

  private readStreamBody(d: PdfDictionary): PdfObject {
    const b = this.lex.buf
    // After "stream": CRLF or LF (spec §7.3.8.1). A lone CR is tolerated.
    if (b[this.lex.pos] === 0x0d && b[this.lex.pos + 1] === 0x0a) this.lex.pos += 2
    else if (b[this.lex.pos] === 0x0a || b[this.lex.pos] === 0x0d) this.lex.pos += 1
    const start = this.lex.pos

    let len = -1
    const lenObj = d.entries.get('Length')
    if (lenObj && isNum(lenObj)) len = lenObj.value
    else if (lenObj && this.resolveLength) {
      const r = this.resolveLength(lenObj)
      if (typeof r === 'number') len = r
    }

    let end: number
    if (len >= 0 && this.looksLikeEndstream(start + len)) {
      end = start + len
    } else {
      end = this.scanForEndstream(start)
    }
    const data = this.lex.slice(start, end)
    // Skip past endstream/endobj for sequential callers.
    this.lex.pos = end
    this.skipUntilAfter('endstream')
    return { kind: 'stream', dict: d, data }
  }

  private looksLikeEndstream(at: number): boolean {
    const b = this.lex.buf
    let p = at
    while (p < b.length && (b[p] === 0x0a || b[p] === 0x0d || b[p] === 0x20 || b[p] === 0x09)) p++
    return latin1(b, p, p + 9) === 'endstream'
  }

  private scanForEndstream(start: number): number {
    const b = this.lex.buf
    const needle = 'endstream'
    for (let p = start; p <= b.length - needle.length; p++) {
      if (b[p] === 0x65 && latin1(b, p, p + needle.length) === needle) {
        // trim a single trailing EOL that belongs to the keyword line
        let e = p
        if (b[e - 1] === 0x0a) e--
        if (b[e - 1] === 0x0d) e--
        return e
      }
    }
    return b.length
  }

  private skipUntilAfter(kw: string): void {
    const b = this.lex.buf
    for (let p = this.lex.pos; p <= b.length - kw.length; p++) {
      if (latin1(b, p, p + kw.length) === kw) {
        this.lex.pos = p + kw.length
        return
      }
    }
    this.lex.pos = b.length
  }
}

/** Convenience: parse a standalone object value from bytes. */
export function parseObjectFrom(buf: Uint8Array, offset = 0): PdfObject {
  return new ObjectParser(new Lexer(buf, offset)).parseObject()
}

export { isDict }
