/**
 * SFNT container parsing (spec §10.2). Reads the table directory and the
 * `head` / `hhea` / `maxp` tables. TrueType (`glyf`) is the milestone-5 path;
 * OpenType/CFF (`OTTO`) is rejected here and arrives in milestone 7.
 *
 * Supports a single-face `.ttf`/`.otf` and a `.ttc` collection (face picked by
 * index). For a `.ttc` face the referenced tables are re-serialized into a
 * standalone SFNT so it can be embedded as a `FontFile2`.
 */

import { BinaryReader } from '../util/binary.ts'
import { UnsupportedFontError, PdfGenError } from '../util/errors.ts'

const TTF_TRUE = 0x00010000
const TTF_TAG_true = 0x74727565 // 'true'
const TTF_TAG_ttcf = 0x74746366 // 'ttcf'
const TTF_TAG_OTTO = 0x4f54544f // 'OTTO'

export interface TableRecord {
  tag: string
  offset: number
  length: number
}

export interface HeadTable {
  unitsPerEm: number
  /** 0 = short loca (offsets ×2), 1 = long loca. */
  indexToLocFormat: 0 | 1
  xMin: number
  yMin: number
  xMax: number
  yMax: number
  macStyle: number
}

export interface HheaTable {
  ascent: number
  descent: number
  lineGap: number
  numberOfHMetrics: number
}

function tagToStr(n: number): string {
  return String.fromCharCode((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff)
}

export class SfntFont {
  readonly tables = new Map<string, TableRecord>()
  readonly head: HeadTable
  readonly hhea: HheaTable
  readonly numGlyphs: number

  /** The standalone SFNT bytes to embed (verbatim, or rebuilt for a TTC). */
  readonly programBytes: Uint8Array

  constructor(bytes: Uint8Array, faceIndex = 0) {
    const r = new BinaryReader(bytes)
    const sfntVersion = r.u32()

    if (sfntVersion === TTF_TAG_ttcf) {
      r.u32() // major/minor version
      const numFonts = r.u32()
      if (faceIndex < 0 || faceIndex >= numFonts) {
        throw new PdfGenError(
          'PDF_UNSUPPORTED_FONT',
          `TTC face index ${faceIndex} out of range (0..${numFonts - 1})`
        )
      }
      const offsets: number[] = []
      for (let i = 0; i < numFonts; i++) offsets.push(r.u32())
      this.readDirectory(bytes, offsets[faceIndex]!)
      this.programBytes = this.rebuildSfnt(bytes)
    } else if (
      sfntVersion === TTF_TRUE ||
      sfntVersion === TTF_TAG_true ||
      sfntVersion === TTF_TAG_OTTO // OpenType/CFF — same SFNT container
    ) {
      this.readDirectory(bytes, 0)
      this.programBytes = bytes // single face — embed verbatim
    } else {
      throw new UnsupportedFontError(
        `Unrecognized font format (sfnt version 0x${sfntVersion.toString(16)})`
      )
    }

    this.head = this.parseHead()
    this.hhea = this.parseHhea()
    this.numGlyphs = this.parseMaxpNumGlyphs()
  }

  /** True for an OpenType/CFF font (`CFF ` outlines, no `glyf`/`loca`). */
  get isCFF(): boolean {
    return this.tables.has('CFF ')
  }

  private readDirectory(bytes: Uint8Array, dirOffset: number): void {
    const r = new BinaryReader(bytes, dirOffset)
    r.u32() // sfnt version (already validated for the chosen face)
    const numTables = r.u16()
    r.u16() // searchRange
    r.u16() // entrySelector
    r.u16() // rangeShift
    for (let i = 0; i < numTables; i++) {
      const tag = tagToStr(r.u32())
      r.u32() // checksum
      const offset = r.u32()
      const length = r.u32()
      this.tables.set(tag, { tag, offset, length })
    }
  }

  private require(tag: string): TableRecord {
    const t = this.tables.get(tag)
    if (!t) {
      throw new UnsupportedFontError(`Font is missing the required '${tag}' table`)
    }
    return t
  }

  /** Raw bytes of a table (subarray, no copy), or undefined if absent. */
  table(tag: string): Uint8Array | undefined {
    const t = this.tables.get(tag)
    return t ? this.bytes.subarray(t.offset, t.offset + t.length) : undefined
  }

  private get bytes(): Uint8Array {
    return this.programBytes
  }

  private parseHead(): HeadTable {
    const t = this.require('head')
    const r = new BinaryReader(this.bytes, t.offset)
    r.seek(t.offset + 18)
    const unitsPerEm = r.u16()
    r.seek(t.offset + 36)
    const xMin = r.i16()
    const yMin = r.i16()
    const xMax = r.i16()
    const yMax = r.i16()
    const macStyle = r.u16()
    r.seek(t.offset + 50)
    const indexToLocFormat = r.i16() as 0 | 1
    return { unitsPerEm, indexToLocFormat, xMin, yMin, xMax, yMax, macStyle }
  }

  private parseHhea(): HheaTable {
    const t = this.require('hhea')
    const r = new BinaryReader(this.bytes, t.offset)
    r.seek(t.offset + 4)
    const ascent = r.i16()
    const descent = r.i16()
    const lineGap = r.i16()
    r.seek(t.offset + 34)
    const numberOfHMetrics = r.u16()
    return { ascent, descent, lineGap, numberOfHMetrics }
  }

  private parseMaxpNumGlyphs(): number {
    const t = this.require('maxp')
    const r = new BinaryReader(this.bytes, t.offset + 4)
    return r.u16()
  }

  /** Rebuild a standalone, 4-byte-aligned SFNT from this face's tables. */
  private rebuildSfnt(src: Uint8Array): Uint8Array {
    const entries = [...this.tables.values()].sort((a, b) => (a.tag < b.tag ? -1 : 1))
    const numTables = entries.length
    const headerLen = 12 + numTables * 16

    const blocks: { rec: TableRecord; data: Uint8Array; offset: number }[] = []
    let cursor = headerLen
    for (const rec of entries) {
      const data = src.subarray(rec.offset, rec.offset + rec.length)
      blocks.push({ rec, data, offset: cursor })
      cursor += (rec.length + 3) & ~3 // pad each table to 4 bytes
    }

    const out = new Uint8Array(cursor)
    const dv = new DataView(out.buffer)
    dv.setUint32(0, TTF_TRUE)
    dv.setUint16(4, numTables)
    const maxPow = Math.floor(Math.log2(numTables))
    const searchRange = 16 * 2 ** maxPow
    dv.setUint16(6, searchRange)
    dv.setUint16(8, maxPow)
    dv.setUint16(10, numTables * 16 - searchRange)

    let p = 12
    for (const b of blocks) {
      for (let i = 0; i < 4; i++) out[p + i] = b.rec.tag.charCodeAt(i)
      dv.setUint32(p + 4, tableChecksum(b.data))
      dv.setUint32(p + 8, b.offset)
      dv.setUint32(p + 12, b.rec.length)
      out.set(b.data, b.offset)
      p += 16
    }

    // Patch head.checkSumAdjustment, then rewrite this.tables to the new layout.
    const head = blocks.find(b => b.rec.tag === 'head')
    if (head) {
      const adj = (0xb1b0afba - tableChecksum(out)) >>> 0
      new DataView(out.buffer).setUint32(head.offset + 8, adj)
    }
    this.tables.clear()
    for (const b of blocks) {
      this.tables.set(b.rec.tag, { tag: b.rec.tag, offset: b.offset, length: b.rec.length })
    }
    return out
  }
}

/** SFNT table checksum: sum of big-endian uint32s, zero-padded (ISO/OpenType). */
export function tableChecksum(data: Uint8Array): number {
  let sum = 0
  const n = (data.length + 3) & ~3
  for (let i = 0; i < n; i += 4) {
    const b0 = data[i] ?? 0
    const b1 = data[i + 1] ?? 0
    const b2 = data[i + 2] ?? 0
    const b3 = data[i + 3] ?? 0
    sum = (sum + (((b0 << 24) | (b1 << 16) | (b2 << 8) | b3) >>> 0)) >>> 0
  }
  return sum >>> 0
}
