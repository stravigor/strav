/**
 * Cross-reference resolution (spec §7.5). Locates the trailing `startxref`,
 * then walks the section chain — classic `xref` tables and `/Type /XRef`
 * streams, plus the hybrid `/XRefStm` pointer — following `/Prev` to older
 * sections. Newest section wins on conflict (first-seen during the walk).
 */

import {
  type PdfObject,
  type PdfDictionary,
  isNum,
  isArr,
  isDict,
  isRef,
  isStream,
} from '../objects/types.ts'
import { PdfParseError } from '../util/errors.ts'
import { decodeStream } from '../streams/decode.ts'
import { Lexer, latin1 } from './lexer.ts'
import { ObjectParser } from './object_parser.ts'

/** Uncompressed object: byte offset. Compressed: container objstm + index. */
export type XrefEntry =
  | { type: 'n'; offset: number; gen: number }
  | { type: 'c'; streamObj: number; index: number }

export interface XrefTable {
  entries: Map<number, XrefEntry>
  trailer: PdfDictionary
}

/** Scan the tail for the last `startxref` and return its offset value. */
export function findStartXref(buf: Uint8Array): number {
  const needle = 'startxref'
  const from = Math.max(0, buf.length - 2048)
  for (let p = buf.length - needle.length; p >= from; p--) {
    if (buf[p] === 0x73 && latin1(buf, p, p + needle.length) === needle) {
      const lex = new Lexer(buf, p + needle.length)
      const t = lex.next()
      if (t.type === 'num') return t.value
    }
  }
  throw new PdfParseError('No startxref found')
}

export function parseXref(buf: Uint8Array): XrefTable {
  const entries = new Map<number, XrefEntry>()
  let trailer: PdfDictionary | undefined
  const visited = new Set<number>()
  const queue: number[] = [findStartXref(buf)]

  while (queue.length) {
    const off = queue.shift()!
    if (off < 0 || off >= buf.length || visited.has(off)) continue
    visited.add(off)

    const lex = new Lexer(buf, off)
    const t = lex.peek()
    let sectionTrailer: PdfDictionary

    if (t.type === 'kw' && t.value === 'xref') {
      sectionTrailer = parseClassic(buf, off, entries)
    } else {
      sectionTrailer = parseXrefStream(buf, off, entries)
    }
    if (!trailer) trailer = sectionTrailer

    // Hybrid: an /XRefStm points at a parallel xref stream for this section.
    const xrefStm = sectionTrailer.entries.get('XRefStm')
    if (xrefStm && isNum(xrefStm)) queue.push(xrefStm.value)
    const prev = sectionTrailer.entries.get('Prev')
    if (prev && isNum(prev)) queue.push(prev.value)
  }

  if (!trailer) throw new PdfParseError('No trailer dictionary')
  return { entries, trailer }
}

function setIfAbsent(map: Map<number, XrefEntry>, n: number, e: XrefEntry): void {
  if (!map.has(n)) map.set(n, e)
}

function parseClassic(
  buf: Uint8Array,
  off: number,
  entries: Map<number, XrefEntry>,
): PdfDictionary {
  const lex = new Lexer(buf, off)
  lex.next() // 'xref'
  for (;;) {
    const a = lex.next()
    if (a.type === 'kw' && a.value === 'trailer') break
    if (a.type === 'eof') throw new PdfParseError('Unterminated xref table')
    if (a.type !== 'num') throw new PdfParseError('Malformed xref subsection header')
    const count = lex.next()
    if (count.type !== 'num') throw new PdfParseError('Malformed xref subsection header')
    const start = a.value
    for (let i = 0; i < count.value; i++) {
      const offTok = lex.next()
      const genTok = lex.next()
      const kind = lex.next()
      if (offTok.type !== 'num' || genTok.type !== 'num' || kind.type !== 'kw') {
        throw new PdfParseError('Malformed xref entry')
      }
      if (kind.value === 'n') {
        setIfAbsent(entries, start + i, {
          type: 'n',
          offset: offTok.value,
          gen: genTok.value,
        })
      }
    }
  }
  // trailer << … >>
  const parser = new ObjectParser(new Lexer(buf, lex.pos))
  const tr = parser.parseObject()
  if (!isDict(tr)) throw new PdfParseError('Trailer is not a dictionary')
  return tr
}

function parseXrefStream(
  buf: Uint8Array,
  off: number,
  entries: Map<number, XrefEntry>,
): PdfDictionary {
  const parser = new ObjectParser(new Lexer(buf, off))
  const { value } = parser.parseIndirectAt(off)
  if (!isStream(value)) throw new PdfParseError('Expected an xref stream object')
  const d = value.dict
  const data = decodeStream(d, value.data, (o) => o)

  const wObj = d.entries.get('W')
  if (!wObj || !isArr(wObj)) throw new PdfParseError('Xref stream missing /W')
  const W = wObj.items.map((x) => (isNum(x) ? x.value : 0))
  const [w0, w1, w2] = [W[0] ?? 0, W[1] ?? 0, W[2] ?? 0]
  const recLen = w0 + w1 + w2

  const sizeObj = d.entries.get('Size')
  const size = sizeObj && isNum(sizeObj) ? sizeObj.value : 0
  const indexObj = d.entries.get('Index')
  const index: number[] =
    indexObj && isArr(indexObj)
      ? indexObj.items.map((x) => (isNum(x) ? x.value : 0))
      : [0, size]

  const readField = (p: number, w: number, dflt: number): number => {
    if (w === 0) return dflt
    let v = 0
    for (let k = 0; k < w; k++) v = v * 256 + data[p + k]!
    return v
  }

  let pos = 0
  for (let s = 0; s + 1 < index.length; s += 2) {
    const start = index[s]!
    const cnt = index[s + 1]!
    for (let i = 0; i < cnt && pos + recLen <= data.length; i++) {
      const objNum = start + i
      const type = readField(pos, w0, 1)
      const f2 = readField(pos + w0, w1, 0)
      const f3 = readField(pos + w0 + w1, w2, 0)
      pos += recLen
      if (type === 1) {
        setIfAbsent(entries, objNum, { type: 'n', offset: f2, gen: f3 })
      } else if (type === 2) {
        setIfAbsent(entries, objNum, { type: 'c', streamObj: f2, index: f3 })
      }
    }
  }
  return d
}

/**
 * Last-resort recovery: scan the whole buffer for `N G obj` headers and build
 * an xref table from scratch (latest occurrence wins). Used when the real
 * xref is missing or corrupt.
 */
export function bruteForceXref(buf: Uint8Array): XrefTable {
  const entries = new Map<number, XrefEntry>()
  const re = /(\d+)\s+(\d+)\s+obj\b/g
  const text = latin1(buf, 0, buf.length)
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const n = Number(m[1])
    const g = Number(m[2])
    entries.set(n, { type: 'n', offset: m.index, gen: g })
  }
  // Locate a trailer dict, else synthesize from a /Root /Catalog scan.
  let trailer: PdfDictionary | undefined
  const tIdx = text.lastIndexOf('trailer')
  if (tIdx >= 0) {
    try {
      const tr = new ObjectParser(new Lexer(buf, tIdx + 7)).parseObject()
      if (isDict(tr)) trailer = tr
    } catch {
      /* fall through */
    }
  }
  if (!trailer || !trailer.entries.has('Root')) {
    trailer = synthesizeTrailer(buf, entries)
  }
  return { entries, trailer }
}

function synthesizeTrailer(
  buf: Uint8Array,
  entries: Map<number, XrefEntry>,
): PdfDictionary {
  for (const [n, e] of entries) {
    if (e.type !== 'n') continue
    try {
      const { value } = new ObjectParser(new Lexer(buf, e.offset)).parseIndirectAt(e.offset)
      const d = isStream(value) ? value.dict : value
      if (isDict(d)) {
        const ty = d.entries.get('Type')
        if (ty && 'value' in ty && ty.value === 'Catalog') {
          const tr: PdfDictionary = { kind: 'dict', entries: new Map() }
          tr.entries.set('Root', { kind: 'ref', num: n, gen: e.gen })
          return tr
        }
      }
    } catch {
      /* skip unparseable objects */
    }
  }
  throw new PdfParseError('Could not recover a document catalog')
}

export { isRef }
