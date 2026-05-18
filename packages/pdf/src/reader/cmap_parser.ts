/**
 * CMap parser (spec §9.7.5 / §9.10.3) — the inverse of
 * `fonts/to_unicode.ts#buildToUnicode`. Parses `codespacerange`, `bfchar`,
 * `bfrange` (incl. the `[…]` array form) and `cidchar`/`cidrange`. Used for
 * `/ToUnicode` (code → Unicode) and embedded Type0 encodings (code → CID).
 */

import { Lexer, type Token } from './lexer.ts'

interface CodespaceRange {
  nbytes: number
  low: number
  high: number
}

export class CMap {
  private readonly codespaces: CodespaceRange[] = []
  /** code → Unicode string (bf*) */
  private readonly toStr = new Map<number, string>()
  /** code → CID (cid*) */
  private readonly toCid = new Map<number, number>()
  private bfRanges: { lo: number; hi: number; base: string }[] = []
  private cidRanges: { lo: number; hi: number; base: number }[] = []

  /** Byte length to read for the next code (uniform-codespace heuristic). */
  get codeBytes(): number {
    if (this.codespaces.length === 0) return 1
    return this.codespaces[0]!.nbytes
  }

  /** Split a show string into numeric character codes. */
  readCodes(bytes: Uint8Array): number[] {
    const out: number[] = []
    const n = this.codeBytes
    for (let i = 0; i + n <= bytes.length; i += n) {
      let c = 0
      for (let k = 0; k < n; k++) c = (c << 8) | bytes[i + k]!
      out.push(c)
    }
    return out
  }

  unicodeOf(code: number): string | undefined {
    const direct = this.toStr.get(code)
    if (direct !== undefined) return direct
    for (const r of this.bfRanges) {
      if (code >= r.lo && code <= r.hi) {
        // Increment the last UTF-16 unit of the base by the offset.
        const cps = [...r.base]
        const off = code - r.lo
        const last = cps.pop() ?? ''
        return cps.join('') + String.fromCodePoint((last.codePointAt(0) ?? 0) + off)
      }
    }
    return undefined
  }

  cidOf(code: number): number | undefined {
    const direct = this.toCid.get(code)
    if (direct !== undefined) return direct
    for (const r of this.cidRanges) {
      if (code >= r.lo && code <= r.hi) return r.base + (code - r.lo)
    }
    return undefined
  }
}

const bytesToInt = (b: Uint8Array): number => {
  let v = 0
  for (const x of b) v = (v << 8) | x
  return v
}

const utf16beToStr = (b: Uint8Array): string => {
  let s = ''
  for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode((b[i]! << 8) | b[i + 1]!)
  // Normalize surrogate pairs into proper code points.
  return [...s].join('')
}

export function parseCMap(content: Uint8Array): CMap {
  const cmap = new CMap()
  const lex = new Lexer(content, 0)
  const internal = cmap as unknown as {
    codespaces: CodespaceRange[]
    toStr: Map<number, string>
    toCid: Map<number, number>
    bfRanges: { lo: number; hi: number; base: string }[]
    cidRanges: { lo: number; hi: number; base: number }[]
  }

  const next = (): Token => lex.next()

  for (;;) {
    const t = next()
    if (t.type === 'eof') break
    if (t.type !== 'kw') continue

    if (t.value === 'begincodespacerange') {
      for (;;) {
        const lo = next()
        if (lo.type === 'kw' && lo.value === 'endcodespacerange') break
        if (lo.type === 'eof') break
        const hi = next()
        if (lo.type === 'str' && hi.type === 'str') {
          internal.codespaces.push({
            nbytes: lo.value.length || 1,
            low: bytesToInt(lo.value),
            high: bytesToInt(hi.value),
          })
        }
      }
    } else if (t.value === 'beginbfchar') {
      for (;;) {
        const src = next()
        if (src.type === 'kw' && src.value === 'endbfchar') break
        if (src.type === 'eof') break
        const dst = next()
        if (src.type === 'str' && dst.type === 'str') {
          internal.toStr.set(bytesToInt(src.value), utf16beToStr(dst.value))
        }
      }
    } else if (t.value === 'beginbfrange') {
      for (;;) {
        const lo = next()
        if (lo.type === 'kw' && lo.value === 'endbfrange') break
        if (lo.type === 'eof') break
        const hi = next()
        const dst = next()
        if (lo.type !== 'str' || hi.type !== 'str') continue
        const loN = bytesToInt(lo.value)
        const hiN = bytesToInt(hi.value)
        if (dst.type === 'str') {
          internal.bfRanges.push({ lo: loN, hi: hiN, base: utf16beToStr(dst.value) })
        } else if (dst.type === 'delim' && dst.value === '[') {
          let i = loN
          for (;;) {
            const el = next()
            if (el.type === 'delim' && el.value === ']') break
            if (el.type === 'eof') break
            if (el.type === 'str') internal.toStr.set(i++, utf16beToStr(el.value))
          }
        }
      }
    } else if (t.value === 'begincidchar') {
      for (;;) {
        const src = next()
        if (src.type === 'kw' && src.value === 'endcidchar') break
        if (src.type === 'eof') break
        const cid = next()
        if (src.type === 'str' && cid.type === 'num') {
          internal.toCid.set(bytesToInt(src.value), cid.value)
        }
      }
    } else if (t.value === 'begincidrange') {
      for (;;) {
        const lo = next()
        if (lo.type === 'kw' && lo.value === 'endcidrange') break
        if (lo.type === 'eof') break
        const hi = next()
        const cid = next()
        if (lo.type === 'str' && hi.type === 'str' && cid.type === 'num') {
          internal.cidRanges.push({
            lo: bytesToInt(lo.value),
            hi: bytesToInt(hi.value),
            base: cid.value,
          })
        }
      }
    }
  }
  return cmap
}
