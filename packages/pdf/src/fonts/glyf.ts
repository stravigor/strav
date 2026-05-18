/**
 * `loca` + `glyf` reading (spec §10.2). Milestone 5 embeds the whole font, so
 * this isn't on the embed path yet — but it provides the loca offsets and
 * composite-glyph component closure that milestone-6 subsetting builds on.
 */

import { BinaryReader } from '../util/binary.ts'

const ARG_1_AND_2_ARE_WORDS = 0x0001
const WE_HAVE_A_SCALE = 0x0008
const MORE_COMPONENTS = 0x0020
const WE_HAVE_AN_X_AND_Y_SCALE = 0x0040
const WE_HAVE_A_TWO_BY_TWO = 0x0080

export class GlyfTable {
  /** Glyph data offsets, length numGlyphs+1 (offset[i+1]-offset[i] = size). */
  readonly loca: number[] = []

  constructor(
    loca: Uint8Array,
    private readonly glyf: Uint8Array,
    numGlyphs: number,
    longLoca: boolean
  ) {
    const r = new BinaryReader(loca)
    for (let i = 0; i <= numGlyphs; i++) {
      this.loca.push(longLoca ? r.u32() : r.u16() * 2)
    }
  }

  /** Raw glyph bytes for `gid` (empty for whitespace/.notdef). */
  glyphData(gid: number): Uint8Array {
    const start = this.loca[gid] ?? 0
    const end = this.loca[gid + 1] ?? start
    return this.glyf.subarray(start, end)
  }

  /** Component glyph indices referenced by a composite glyph (else []). */
  componentGids(gid: number): number[] {
    const data = this.glyphData(gid)
    if (data.length < 10) return []
    const r = new BinaryReader(data)
    const numberOfContours = r.i16()
    if (numberOfContours >= 0) return [] // simple glyph
    r.seek(10) // skip bbox
    const out: number[] = []
    for (;;) {
      const flags = r.u16()
      out.push(r.u16())
      let skip = flags & ARG_1_AND_2_ARE_WORDS ? 4 : 2
      if (flags & WE_HAVE_A_SCALE) skip += 2
      else if (flags & WE_HAVE_AN_X_AND_Y_SCALE) skip += 4
      else if (flags & WE_HAVE_A_TWO_BY_TWO) skip += 8
      r.seek(r.position + skip)
      if (!(flags & MORE_COMPONENTS)) break
    }
    return out
  }
}
