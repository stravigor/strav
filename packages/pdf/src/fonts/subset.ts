/**
 * TrueType glyph subsetting (spec §10.3).
 *
 * Strategy (per spec): keep the original glyph indices — unused glyphs become
 * zero-length, trailing unused glyphs are dropped (numGlyphs = maxUsedGid+1).
 * Because indices are preserved, the content stream's Identity-H codes, the
 * CIDFont `/W` array, `ToUnicode` and `CIDToGIDMap /Identity` need no rewrite.
 *
 * Tables rewritten: `glyf`, `loca` (long), `hmtx`, `maxp.numGlyphs`,
 * `hhea.numberOfHMetrics`, `head` (indexToLocFormat + checkSumAdjustment).
 * Every other table is passed through unchanged.
 *
 * The 6-letter subset tag is derived from the subset content (sorted glyph
 * set + source numGlyphs), so identical input → identical font (determinism).
 */

import { tableChecksum, type SfntFont } from './sfnt.ts'
import { GlyfTable } from './glyf.ts'

export interface SubsetResult {
  bytes: Uint8Array
  /** Six uppercase letters, e.g. `ABCDEF` (caller forms `ABCDEF+Name`). */
  tag: string
}

function pad4(n: number): number {
  return (n + 3) & ~3
}

/** FNV-1a over the subset's identifying content → 6 uppercase A–Z letters. */
function subsetTag(sortedGids: number[], srcNumGlyphs: number): string {
  let h = 0x811c9dc5
  const mix = (x: number) => {
    h ^= x & 0xff
    h = Math.imul(h, 0x01000193) >>> 0
  }
  mix(srcNumGlyphs & 0xff)
  mix((srcNumGlyphs >> 8) & 0xff)
  for (const g of sortedGids) {
    mix(g & 0xff)
    mix((g >> 8) & 0xff)
  }
  let tag = ''
  let v = h >>> 0
  for (let i = 0; i < 6; i++) {
    tag += String.fromCharCode(65 + (v % 26))
    v = Math.floor(v / 26) + 0x9e3779b1 // re-stir so all 6 letters vary
    v >>>= 0
  }
  return tag
}

/** Read (advance, lsb) for every glyph 0..n-1 from the original hmtx. */
function readMetrics(
  hmtx: Uint8Array,
  numberOfHMetrics: number,
  count: number
): { adv: number; lsb: number }[] {
  const out: { adv: number; lsb: number }[] = []
  let lastAdv = 0
  for (let g = 0; g < count; g++) {
    if (g < numberOfHMetrics) {
      const o = g * 4
      lastAdv = (hmtx[o]! << 8) | hmtx[o + 1]!
      const lsbRaw = (hmtx[o + 2]! << 8) | hmtx[o + 3]!
      out.push({ adv: lastAdv, lsb: (lsbRaw << 16) >> 16 })
    } else {
      const o = numberOfHMetrics * 4 + (g - numberOfHMetrics) * 2
      const lsbRaw = ((hmtx[o] ?? 0) << 8) | (hmtx[o + 1] ?? 0)
      out.push({ adv: lastAdv, lsb: (lsbRaw << 16) >> 16 })
    }
  }
  return out
}

/** Assemble a standalone, 4-byte-aligned SFNT and patch head.checkSumAdjustment. */
function assembleSfnt(tables: Map<string, Uint8Array>): Uint8Array {
  const tags = [...tables.keys()].sort()
  const numTables = tags.length
  const headerLen = 12 + numTables * 16

  const placed: { tag: string; data: Uint8Array; offset: number; length: number }[] = []
  let cursor = headerLen
  for (const tag of tags) {
    const data = tables.get(tag)!
    placed.push({ tag, data, offset: cursor, length: data.length })
    cursor += pad4(data.length)
  }

  const out = new Uint8Array(cursor)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, 0x00010000)
  dv.setUint16(4, numTables)
  const maxPow = Math.floor(Math.log2(numTables))
  const searchRange = 16 * 2 ** maxPow
  dv.setUint16(6, searchRange)
  dv.setUint16(8, maxPow)
  dv.setUint16(10, numTables * 16 - searchRange)

  let p = 12
  for (const b of placed) {
    for (let i = 0; i < 4; i++) out[p + i] = b.tag.charCodeAt(i)
    dv.setUint32(p + 4, tableChecksum(b.data))
    dv.setUint32(p + 8, b.offset)
    dv.setUint32(p + 12, b.length)
    out.set(b.data, b.offset)
    p += 16
  }

  const head = placed.find(b => b.tag === 'head')
  if (head) {
    dv.setUint32(head.offset + 8, 0) // zero before computing
    const adj = (0xb1b0afba - tableChecksum(out)) >>> 0
    dv.setUint32(head.offset + 8, adj)
  }
  return out
}

export function subsetTrueType(
  sfnt: SfntFont,
  used: Iterable<number>
): SubsetResult {
  const loca = sfnt.table('loca')
  const glyf = sfnt.table('glyf')
  if (!loca || !glyf) {
    throw new Error('subsetTrueType requires a glyf-based TrueType font')
  }
  const srcN = sfnt.numGlyphs
  const glyfTable = new GlyfTable(loca, glyf, srcN, sfnt.head.indexToLocFormat === 1)

  // Used set + transitive composite-component closure; .notdef always in.
  const keep = new Set<number>([0])
  const stack: number[] = [0]
  for (const g of used) {
    if (g >= 0 && g < srcN && !keep.has(g)) {
      keep.add(g)
      stack.push(g)
    }
  }
  while (stack.length) {
    const g = stack.pop()!
    for (const comp of glyfTable.componentGids(g)) {
      if (comp >= 0 && comp < srcN && !keep.has(comp)) {
        keep.add(comp)
        stack.push(comp)
      }
    }
  }

  const sortedGids = [...keep].sort((a, b) => a - b)
  const maxGid = sortedGids[sortedGids.length - 1]!
  const newN = maxGid + 1

  // Rebuild glyf + long loca, keeping original indices (empty if unused).
  const glyphs: Uint8Array[] = []
  const locaOffsets: number[] = []
  let off = 0
  for (let gid = 0; gid < newN; gid++) {
    locaOffsets.push(off)
    if (keep.has(gid)) {
      const data = glyfTable.glyphData(gid)
      const padded = pad4(data.length)
      const buf = new Uint8Array(padded)
      buf.set(data)
      glyphs.push(buf)
      off += padded
    }
  }
  locaOffsets.push(off)

  const newGlyf = new Uint8Array(off)
  {
    let o = 0
    for (const g of glyphs) {
      newGlyf.set(g, o)
      o += g.length
    }
  }
  const newLoca = new Uint8Array((newN + 1) * 4)
  {
    const dv = new DataView(newLoca.buffer)
    for (let i = 0; i <= newN; i++) dv.setUint32(i * 4, locaOffsets[i]!)
  }

  // Fresh hmtx: full (advance, lsb) pair for every kept glyph.
  const hmtxTable = sfnt.table('hmtx')!
  const metrics = readMetrics(hmtxTable, sfnt.hhea.numberOfHMetrics, newN)
  const newHmtx = new Uint8Array(newN * 4)
  {
    const dv = new DataView(newHmtx.buffer)
    for (let g = 0; g < newN; g++) {
      dv.setUint16(g * 4, metrics[g]!.adv)
      dv.setInt16(g * 4 + 2, metrics[g]!.lsb)
    }
  }

  // Patched head / hhea / maxp (copies of the originals).
  const head = Uint8Array.from(sfnt.table('head')!)
  new DataView(head.buffer, head.byteOffset).setUint32(8, 0) // checkSumAdjustment
  new DataView(head.buffer, head.byteOffset).setInt16(50, 1) // indexToLocFormat=long

  const hhea = Uint8Array.from(sfnt.table('hhea')!)
  new DataView(hhea.buffer, hhea.byteOffset).setUint16(34, newN) // numberOfHMetrics

  const maxp = Uint8Array.from(sfnt.table('maxp')!)
  new DataView(maxp.buffer, maxp.byteOffset).setUint16(4, newN) // numGlyphs

  const out = new Map<string, Uint8Array>()
  for (const tag of sfnt.tables.keys()) {
    const data = sfnt.table(tag)
    if (data) out.set(tag, data)
  }
  out.set('glyf', newGlyf)
  out.set('loca', newLoca)
  out.set('hmtx', newHmtx)
  out.set('head', head)
  out.set('hhea', hhea)
  out.set('maxp', maxp)

  return { bytes: assembleSfnt(out), tag: subsetTag(sortedGids, srcN) }
}
