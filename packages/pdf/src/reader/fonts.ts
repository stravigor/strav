/**
 * Per-font text decoding (spec §9.6–9.10). Builds a {@link CharMap} that turns
 * show-string bytes into Unicode + glyph advance widths. Decoding precedence:
 *   1. /ToUnicode CMap
 *   2. simple-font /Encoding (base + /Differences) → glyph name → Unicode
 *   3. Type0 Identity/embedded-CMap → CID (Unicode only via /ToUnicode)
 *   4. raw byte → WinAnsi/Latin-1 fallback
 */

import {
  type PdfObject,
  type PdfDictionary,
  isDict,
  isName,
  isNum,
  isArr,
  isStream,
} from '../objects/types.ts'
import {
  isStandardFontName,
  standardGlyphWidth,
  type StandardFontName,
} from '../fonts/standard_14.ts'
import {
  baseEncode,
  winAnsiToUnicode,
  glyphNameToUnicode,
  type BaseEncodingName,
} from './encodings.ts'
import { parseCMap, type CMap } from './cmap_parser.ts'

export interface DecodedGlyph {
  code: number
  unicode: string
  /** Advance width in text space units per em/1000 (i.e. glyph-space/1000). */
  width1000: number
}

export interface CharMap {
  decode(bytes: Uint8Array): DecodedGlyph[]
  /** Width of the space-like glyph (code 32 / CID space), in /1000 units. */
  spaceWidth: number
}

interface Doc {
  resolve(o: PdfObject | undefined): PdfObject | undefined
  getStreamData(s: Extract<PdfObject, { kind: 'stream' }>, num: number): Uint8Array
}

const REPLACEMENT = '�'

export function buildCharMap(fontDict: PdfDictionary, doc: Doc): CharMap {
  const subtype = nameOf(doc.resolve(fontDict.entries.get('Subtype')))
  const toUni = loadToUnicode(fontDict, doc)

  if (subtype === 'Type0') return type0CharMap(fontDict, doc, toUni)
  return simpleCharMap(fontDict, doc, toUni)
}

// ── Simple fonts (Type1 / TrueType / Type3 / MMType1) ──────────────────────

function simpleCharMap(fontDict: PdfDictionary, doc: Doc, toUni?: CMap): CharMap {
  const base = nameOf(doc.resolve(fontDict.entries.get('BaseFont'))) ?? ''
  const std = isStandardFontName(base) ? (base as StandardFontName) : undefined

  // Widths
  const firstChar = numOf(doc.resolve(fontDict.entries.get('FirstChar'))) ?? 0
  const widthsArr = doc.resolve(fontDict.entries.get('Widths'))
  const widths: number[] = widthsArr && isArr(widthsArr)
    ? widthsArr.items.map((w) => {
        const r = doc.resolve(w)
        return r && isNum(r) ? r.value : 0
      })
    : []
  let missingWidth = 0
  const fd = doc.resolve(fontDict.entries.get('FontDescriptor'))
  if (fd && isDict(fd)) {
    missingWidth = numOf(doc.resolve(fd.entries.get('MissingWidth'))) ?? 0
  }

  // Encoding → per-code Unicode (used only when there is no /ToUnicode).
  const encUnicode = buildSimpleEncoding(fontDict, doc)

  const widthOf = (code: number): number => {
    const idx = code - firstChar
    if (idx >= 0 && idx < widths.length && widths[idx]! > 0) return widths[idx]!
    if (std) return standardGlyphWidth(std, code)
    return missingWidth
  }

  const uniOf = (code: number): string => {
    if (toUni) {
      const u = toUni.unicodeOf(code)
      if (u !== undefined && u !== '') return u
    }
    const e = encUnicode[code]
    if (e !== undefined && e >= 0) return String.fromCodePoint(e)
    const w = winAnsiToUnicode(code)
    return w ? String.fromCodePoint(w) : ''
  }

  return {
    spaceWidth: widthOf(0x20) || (std ? standardGlyphWidth(std, 0x20) : 250),
    decode(bytes) {
      const out: DecodedGlyph[] = []
      for (const code of bytes) {
        out.push({ code, unicode: uniOf(code), width1000: widthOf(code) })
      }
      return out
    },
  }
}

function buildSimpleEncoding(fontDict: PdfDictionary, doc: Doc): number[] {
  const table: number[] = new Array(256)
  const enc = doc.resolve(fontDict.entries.get('Encoding'))
  let baseName: BaseEncodingName | undefined
  if (enc && isName(enc)) baseName = enc.value as BaseEncodingName
  else if (enc && isDict(enc)) {
    const be = doc.resolve(enc.entries.get('BaseEncoding'))
    if (be && isName(be)) baseName = be.value as BaseEncodingName
  }
  for (let c = 0; c < 256; c++) table[c] = baseEncode(baseName, c)
  // /Differences: [ code /name /name code /name … ]
  if (enc && isDict(enc)) {
    const diffs = doc.resolve(enc.entries.get('Differences'))
    if (diffs && isArr(diffs)) {
      let cur = 0
      for (const item of diffs.items) {
        const r = doc.resolve(item)
        if (r && isNum(r)) cur = r.value
        else if (r && isName(r)) {
          const u = glyphNameToUnicode(r.value)
          table[cur] = u >= 0 ? u : table[cur]!
          cur++
        }
      }
    }
  }
  return table
}

// ── Composite (Type0) fonts ────────────────────────────────────────────────

function type0CharMap(fontDict: PdfDictionary, doc: Doc, toUni?: CMap): CharMap {
  // Encoding: Identity-H/V → 2-byte identity; or an embedded/named CMap.
  const enc = doc.resolve(fontDict.entries.get('Encoding'))
  let encCMap: CMap | undefined
  let identity = true
  if (enc && isName(enc)) {
    identity = enc.value === 'Identity-H' || enc.value === 'Identity-V'
  } else if (enc && isStream(enc)) {
    encCMap = parseCMap(doc.getStreamData(enc, -1))
    identity = false
  }

  // Descendant CIDFont: /DW + /W widths, keyed by CID.
  let dw = 1000
  const widthByCid = new Map<number, number>()
  const desc = doc.resolve(fontDict.entries.get('DescendantFonts'))
  if (desc && isArr(desc) && desc.items[0]) {
    const cidFont = doc.resolve(desc.items[0])
    if (cidFont && isDict(cidFont)) {
      dw = numOf(doc.resolve(cidFont.entries.get('DW'))) ?? 1000
      const W = doc.resolve(cidFont.entries.get('W'))
      if (W && isArr(W)) parseCidWidths(W.items, doc, widthByCid)
    }
  }

  const codeBytes = encCMap ? encCMap.codeBytes : 2
  const cidOf = (code: number): number =>
    identity ? code : (encCMap?.cidOf(code) ?? code)

  const uniOf = (code: number): string => {
    if (toUni) {
      const u = toUni.unicodeOf(code)
      if (u !== undefined && u !== '') return u
    }
    return REPLACEMENT // no ToUnicode for an embedded-cmap-only font (limitation)
  }

  return {
    spaceWidth: widthByCid.get(cidOf(0x20)) ?? dw,
    decode(bytes) {
      const out: DecodedGlyph[] = []
      const codes = encCMap ? encCMap.readCodes(bytes) : readFixed(bytes, codeBytes)
      for (const code of codes) {
        const cid = cidOf(code)
        out.push({
          code,
          unicode: uniOf(code),
          width1000: widthByCid.get(cid) ?? dw,
        })
      }
      return out
    },
  }
}

function readFixed(bytes: Uint8Array, n: number): number[] {
  const out: number[] = []
  for (let i = 0; i + n <= bytes.length; i += n) {
    let c = 0
    for (let k = 0; k < n; k++) c = (c << 8) | bytes[i + k]!
    out.push(c)
  }
  return out
}

function parseCidWidths(
  items: PdfObject[],
  doc: Doc,
  out: Map<number, number>,
): void {
  let i = 0
  while (i < items.length) {
    const a = doc.resolve(items[i])
    if (!a || !isNum(a)) break
    const next = doc.resolve(items[i + 1])
    if (next && isArr(next)) {
      // c [ w1 w2 … ] : CIDs c, c+1, …
      let cid = a.value
      for (const w of next.items) {
        const wr = doc.resolve(w)
        if (wr && isNum(wr)) out.set(cid++, wr.value)
      }
      i += 2
    } else {
      // c1 c2 w : CIDs c1..c2 all width w
      const b = doc.resolve(items[i + 1])
      const w = doc.resolve(items[i + 2])
      if (b && isNum(b) && w && isNum(w)) {
        for (let cid = a.value; cid <= b.value; cid++) out.set(cid, w.value)
      }
      i += 3
    }
  }
}

// ── Shared helpers ─────────────────────────────────────────────────────────

function loadToUnicode(fontDict: PdfDictionary, doc: Doc): CMap | undefined {
  const tu = doc.resolve(fontDict.entries.get('ToUnicode'))
  if (tu && isStream(tu)) {
    try {
      return parseCMap(doc.getStreamData(tu, -1))
    } catch {
      return undefined
    }
  }
  return undefined
}

function nameOf(o: PdfObject | undefined): string | undefined {
  return o && isName(o) ? o.value : undefined
}
function numOf(o: PdfObject | undefined): number | undefined {
  return o && isNum(o) ? o.value : undefined
}
