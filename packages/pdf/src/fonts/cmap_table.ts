/**
 * `cmap` table parsing (spec §10.2). Maps Unicode code points to glyph
 * indices. Subtable formats 0, 4, 6 and 12 are supported — enough for the
 * Unicode BMP (format 4), full Unicode (format 12), and legacy fonts.
 *
 * The best available Unicode subtable is selected; symbol fonts (3,0) are
 * also tried with the 0xF000 private-use offset.
 */

import { BinaryReader } from '../util/binary.ts'
import { UnsupportedFontError } from '../util/errors.ts'

export interface CmapLookup {
  /** Glyph index for a code point, or 0 (.notdef) if unmapped. */
  gidFor(codePoint: number): number
}

function parseFormat0(b: Uint8Array, o: number): CmapLookup {
  const table = b.subarray(o + 6, o + 6 + 256)
  return { gidFor: cp => (cp < 256 ? table[cp]! : 0) }
}

function parseFormat4(b: Uint8Array, o: number): CmapLookup {
  const r = new BinaryReader(b, o)
  r.seek(o + 6)
  const segX2 = r.u16()
  const segs = segX2 / 2
  const endBase = o + 14
  const startBase = endBase + segX2 + 2
  const deltaBase = startBase + segX2
  const rangeBase = deltaBase + segX2
  const u16 = (base: number, i: number) =>
    (b[base + i * 2]! << 8) | b[base + i * 2 + 1]!
  return {
    gidFor(cp) {
      if (cp > 0xffff) return 0
      for (let i = 0; i < segs; i++) {
        if (cp > u16(endBase, i)) continue
        const start = u16(startBase, i)
        if (cp < start) return 0
        const delta = u16(deltaBase, i)
        const ro = u16(rangeBase, i)
        if (ro === 0) return (cp + delta) & 0xffff
        // glyphId address = rangeBase+i*2 + ro + (cp-start)*2
        const gi = rangeBase + i * 2 + ro + (cp - start) * 2
        const g = (b[gi]! << 8) | b[gi + 1]!
        return g === 0 ? 0 : (g + delta) & 0xffff
      }
      return 0
    },
  }
}

function parseFormat6(b: Uint8Array, o: number): CmapLookup {
  const first = (b[o + 6]! << 8) | b[o + 7]!
  const count = (b[o + 8]! << 8) | b[o + 9]!
  return {
    gidFor(cp) {
      const i = cp - first
      if (i < 0 || i >= count) return 0
      const a = o + 10 + i * 2
      return (b[a]! << 8) | b[a + 1]!
    },
  }
}

function parseFormat12(b: Uint8Array, o: number): CmapLookup {
  const r = new BinaryReader(b, o + 12)
  const nGroups = r.u32()
  const base = o + 16
  return {
    gidFor(cp) {
      let lo = 0
      let hi = nGroups - 1
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        const g = base + mid * 12
        const start = (b[g]! << 24) | (b[g + 1]! << 16) | (b[g + 2]! << 8) | b[g + 3]!
        const end = (b[g + 4]! << 24) | (b[g + 5]! << 16) | (b[g + 6]! << 8) | b[g + 7]!
        if (cp < start >>> 0) hi = mid - 1
        else if (cp > end >>> 0) lo = mid + 1
        else {
          const sg = (b[g + 8]! << 24) | (b[g + 9]! << 16) | (b[g + 10]! << 8) | b[g + 11]!
          return ((sg >>> 0) + (cp - (start >>> 0))) & 0xffffffff
        }
      }
      return 0
    },
  }
}

/** Format 13: like 12, but every code in a group maps to the SAME glyph
 *  (used by LastResort and many fallback fonts). */
function parseFormat13(b: Uint8Array, o: number): CmapLookup {
  const r = new BinaryReader(b, o + 12)
  const nGroups = r.u32()
  const base = o + 16
  return {
    gidFor(cp) {
      let lo = 0
      let hi = nGroups - 1
      while (lo <= hi) {
        const mid = (lo + hi) >> 1
        const g = base + mid * 12
        const start =
          ((b[g]! << 24) | (b[g + 1]! << 16) | (b[g + 2]! << 8) | b[g + 3]!) >>> 0
        const end =
          ((b[g + 4]! << 24) | (b[g + 5]! << 16) | (b[g + 6]! << 8) | b[g + 7]!) >>> 0
        if (cp < start) hi = mid - 1
        else if (cp > end) lo = mid + 1
        else return ((b[g + 8]! << 24) | (b[g + 9]! << 16) | (b[g + 10]! << 8) | b[g + 11]!) >>> 0
      }
      return 0
    },
  }
}

function parseSubtable(b: Uint8Array, o: number): CmapLookup | null {
  const format = (b[o]! << 8) | b[o + 1]!
  switch (format) {
    case 0:
      return parseFormat0(b, o)
    case 4:
      return parseFormat4(b, o)
    case 6:
      return parseFormat6(b, o)
    case 12:
      return parseFormat12(b, o)
    case 13:
      return parseFormat13(b, o)
    default:
      return null
  }
}

/** Parse a `cmap` table and return a Unicode lookup. */
export function parseCmap(cmap: Uint8Array): CmapLookup {
  const numTables = (cmap[2]! << 8) | cmap[3]!
  type Cand = { platform: number; encoding: number; offset: number }
  const cands: Cand[] = []
  for (let i = 0; i < numTables; i++) {
    const rec = 4 + i * 8
    const platform = (cmap[rec]! << 8) | cmap[rec + 1]!
    const encoding = (cmap[rec + 2]! << 8) | cmap[rec + 3]!
    const offset =
      (cmap[rec + 4]! << 24) |
      (cmap[rec + 5]! << 16) |
      (cmap[rec + 6]! << 8) |
      cmap[rec + 7]!
    cands.push({ platform, encoding, offset: offset >>> 0 })
  }

  // Preference: full Unicode → BMP Unicode → any Unicode → symbol.
  const pick = (p: number, e: number) =>
    cands.find(c => c.platform === p && c.encoding === e)
  const order = [
    pick(3, 10),
    pick(0, 6),
    pick(0, 4),
    pick(3, 1),
    pick(0, 3),
    pick(0, 2),
    pick(0, 1),
    pick(0, 0),
    pick(3, 0), // symbol
  ]

  for (const cand of order) {
    if (!cand) continue
    const sub = parseSubtable(cmap, cand.offset)
    if (!sub) continue
    if (cand.platform === 3 && cand.encoding === 0) {
      // Symbol cmap: glyphs live in the 0xF000 private-use block.
      return { gidFor: cp => sub.gidFor(cp) || sub.gidFor(0xf000 + (cp & 0xff)) }
    }
    return sub
  }

  throw new UnsupportedFontError('Font has no usable Unicode cmap subtable')
}
