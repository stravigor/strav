/**
 * PDF tokenizer (spec §7.2). Scans a byte buffer into the lexical tokens the
 * object parser consumes. Pure and position-addressable: callers may `seek`
 * to a known byte offset (from the xref table) and tokenize from there.
 *
 * Whitespace = NUL TAB LF FF CR SPACE. Delimiters = ( ) < > [ ] { } / %.
 * Comments (`%` … EOL) are skipped except the `%PDF`/`%%EOF` markers, which
 * callers locate by raw byte scanning, not through this lexer.
 */

export type Token =
  | { type: 'num'; value: number }
  | { type: 'name'; value: string }
  | { type: 'str'; value: Uint8Array; encoding: 'literal' | 'hex' }
  | { type: 'delim'; value: '[' | ']' | '<<' | '>>' | '{' | '}' }
  | { type: 'kw'; value: string }
  | { type: 'eof' }

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20])
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25])

const isWs = (b: number) => WS.has(b)
const isDelim = (b: number) => DELIM.has(b)
const isRegular = (b: number) => !isWs(b) && !isDelim(b)
const isDigit = (b: number) => b >= 0x30 && b <= 0x39

export class Lexer {
  pos: number

  constructor(
    readonly buf: Uint8Array,
    start = 0,
  ) {
    this.pos = start
  }

  seek(p: number): void {
    this.pos = p
  }

  /** Skip whitespace and `%` comments. */
  skipWs(): void {
    const b = this.buf
    while (this.pos < b.length) {
      const c = b[this.pos]!
      if (isWs(c)) {
        this.pos++
      } else if (c === 0x25) {
        // % comment → to end of line
        this.pos++
        while (this.pos < b.length && b[this.pos] !== 0x0a && b[this.pos] !== 0x0d) this.pos++
      } else {
        break
      }
    }
  }

  /** Peek the next token without consuming (cheap: save/restore pos). */
  peek(): Token {
    const save = this.pos
    const t = this.next()
    this.pos = save
    return t
  }

  next(): Token {
    this.skipWs()
    const b = this.buf
    if (this.pos >= b.length) return { type: 'eof' }
    const c = b[this.pos]!

    // Delimiters / structured tokens
    if (c === 0x5b) {
      this.pos++
      return { type: 'delim', value: '[' }
    }
    if (c === 0x5d) {
      this.pos++
      return { type: 'delim', value: ']' }
    }
    if (c === 0x7b) {
      this.pos++
      return { type: 'delim', value: '{' }
    }
    if (c === 0x7d) {
      this.pos++
      return { type: 'delim', value: '}' }
    }
    if (c === 0x3c) {
      if (b[this.pos + 1] === 0x3c) {
        this.pos += 2
        return { type: 'delim', value: '<<' }
      }
      return this.readHexString()
    }
    if (c === 0x3e) {
      if (b[this.pos + 1] === 0x3e) {
        this.pos += 2
        return { type: 'delim', value: '>>' }
      }
      this.pos++ // stray '>' — tolerate
      return this.next()
    }
    if (c === 0x28) return this.readLiteralString()
    if (c === 0x2f) return this.readName()

    // Number: digit, sign, or '.'
    if (isDigit(c) || c === 0x2b || c === 0x2d || c === 0x2e) {
      const numTok = this.tryReadNumber()
      if (numTok) return numTok
      // fall through: treat as keyword (e.g. malformed) below
    }

    // Keyword / bare token (obj, endobj, stream, R, true, false, null, …)
    let s = this.pos
    while (s < b.length && isRegular(b[s]!)) s++
    if (s === this.pos) {
      this.pos++ // unknown single byte — skip and continue
      return this.next()
    }
    const kw = latin1(b, this.pos, s)
    this.pos = s
    return { type: 'kw', value: kw }
  }

  /** Raw byte access for stream payloads. */
  slice(from: number, to: number): Uint8Array {
    return this.buf.subarray(from, to)
  }

  private tryReadNumber(): Token | null {
    const b = this.buf
    let p = this.pos
    let seenDigit = false
    let seenDot = false
    if (b[p] === 0x2b || b[p] === 0x2d) p++
    while (p < b.length) {
      const ch = b[p]!
      if (isDigit(ch)) {
        seenDigit = true
        p++
      } else if (ch === 0x2e && !seenDot) {
        seenDot = true
        p++
      } else {
        break
      }
    }
    if (!seenDigit) return null
    const str = latin1(b, this.pos, p)
    const value = Number(str)
    if (Number.isNaN(value)) return null
    this.pos = p
    return { type: 'num', value }
  }

  private readName(): Token {
    const b = this.buf
    this.pos++ // skip '/'
    let out = ''
    while (this.pos < b.length) {
      const ch = b[this.pos]!
      if (isWs(ch) || isDelim(ch)) break
      if (ch === 0x23 && this.pos + 2 < b.length) {
        const hi = hexVal(b[this.pos + 1]!)
        const lo = hexVal(b[this.pos + 2]!)
        if (hi >= 0 && lo >= 0) {
          out += String.fromCharCode((hi << 4) | lo)
          this.pos += 3
          continue
        }
      }
      out += String.fromCharCode(ch)
      this.pos++
    }
    return { type: 'name', value: out }
  }

  private readLiteralString(): Token {
    const b = this.buf
    this.pos++ // skip '('
    const out: number[] = []
    let depth = 1
    while (this.pos < b.length) {
      let ch = b[this.pos++]!
      if (ch === 0x5c) {
        // backslash escape
        const e = b[this.pos++]!
        switch (e) {
          case 0x6e: out.push(0x0a); break // \n
          case 0x72: out.push(0x0d); break // \r
          case 0x74: out.push(0x09); break // \t
          case 0x62: out.push(0x08); break // \b
          case 0x66: out.push(0x0c); break // \f
          case 0x28: out.push(0x28); break // \(
          case 0x29: out.push(0x29); break // \)
          case 0x5c: out.push(0x5c); break // \\
          case 0x0d:
            if (b[this.pos] === 0x0a) this.pos++ // \ + CRLF line continuation
            break
          case 0x0a:
            break // \ + LF line continuation
          default:
            if (e >= 0x30 && e <= 0x37) {
              // octal escape (1–3 digits)
              let v = e - 0x30
              for (let k = 0; k < 2; k++) {
                const d = b[this.pos]!
                if (d >= 0x30 && d <= 0x37) {
                  v = (v << 3) | (d - 0x30)
                  this.pos++
                } else break
              }
              out.push(v & 0xff)
            } else {
              out.push(e) // unknown escape → literal char
            }
        }
        continue
      }
      if (ch === 0x28) {
        depth++
        out.push(ch)
        continue
      }
      if (ch === 0x29) {
        depth--
        if (depth === 0) break
        out.push(ch)
        continue
      }
      if (ch === 0x0d) {
        // CR or CRLF → normalize to LF inside literal strings
        if (b[this.pos] === 0x0a) this.pos++
        ch = 0x0a
      }
      out.push(ch)
    }
    return { type: 'str', value: Uint8Array.from(out), encoding: 'literal' }
  }

  private readHexString(): Token {
    const b = this.buf
    this.pos++ // skip '<'
    const nibbles: number[] = []
    while (this.pos < b.length) {
      const ch = b[this.pos++]!
      if (ch === 0x3e) break
      const v = hexVal(ch)
      if (v >= 0) nibbles.push(v)
    }
    if (nibbles.length % 2 === 1) nibbles.push(0)
    const out = new Uint8Array(nibbles.length / 2)
    for (let i = 0; i < out.length; i++) out[i] = (nibbles[2 * i]! << 4) | nibbles[2 * i + 1]!
    return { type: 'str', value: out, encoding: 'hex' }
  }
}

function hexVal(b: number): number {
  if (b >= 0x30 && b <= 0x39) return b - 0x30
  if (b >= 0x41 && b <= 0x46) return b - 0x41 + 10
  if (b >= 0x61 && b <= 0x66) return b - 0x61 + 10
  return -1
}

export function latin1(b: Uint8Array, from: number, to: number): string {
  let s = ''
  for (let i = from; i < to; i++) s += String.fromCharCode(b[i]!)
  return s
}
