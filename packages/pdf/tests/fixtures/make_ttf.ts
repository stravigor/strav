/**
 * Hermetic synthetic TrueType (glyf) font generator for tests.
 *
 * Produces a tiny but structurally valid and *renderable* `.ttf`: 4 glyphs
 * (.notdef, two filled boxes for 'H' and 'i', and a blank space), a format-4
 * cmap, long `loca`, and all required tables with correct checksums and
 * `head.checkSumAdjustment`. No committed binary, no network — the real SFNT
 * parser and embedder are exercised end to end.
 *
 * Glyph map: 'H' (U+0048) → gid 1, 'i' (U+0069) → gid 2, ' ' (U+0020) → gid 3.
 */

const UPM = 1000

function be16(v: number): number[] {
  return [(v >>> 8) & 0xff, v & 0xff]
}
function s16(v: number): number[] {
  return be16(v & 0xffff)
}
function be32(v: number): number[] {
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]
}
function pad4(a: number[]): number[] {
  while (a.length % 4 !== 0) a.push(0)
  return a
}

/** A simple 4-point box contour glyph. */
function boxGlyph(): number[] {
  const g: number[] = []
  g.push(...s16(1)) // numberOfContours
  g.push(...s16(100), ...s16(0), ...s16(700), ...s16(700)) // bbox
  g.push(...be16(3)) // endPtsOfContours[0] = last point index
  g.push(...be16(0)) // instructionLength
  g.push(0x01, 0x01, 0x01, 0x01) // 4 on-curve points, long vectors
  g.push(...s16(100), ...s16(600), ...s16(0), ...s16(-600)) // x deltas
  g.push(...s16(0), ...s16(0), ...s16(700), ...s16(0)) // y deltas
  return pad4(g)
}

function checksum(data: number[]): number {
  let sum = 0
  for (let i = 0; i < data.length; i += 4) {
    const w =
      ((data[i] ?? 0) << 24) |
      ((data[i + 1] ?? 0) << 16) |
      ((data[i + 2] ?? 0) << 8) |
      (data[i + 3] ?? 0)
    sum = (sum + (w >>> 0)) >>> 0
  }
  return sum >>> 0
}

export function makeTrueTypeFont(): Uint8Array {
  const box = boxGlyph()
  const glyf = pad4([...box, ...box]) // gid1, gid2; gid0/gid3 empty
  const loca = [
    ...be32(0), // gid0 .notdef (empty)
    ...be32(0), // gid1 start
    ...be32(box.length), // gid2 start
    ...be32(box.length * 2), // gid3 start (empty)
    ...be32(box.length * 2), // end
  ]

  const head = pad4([
    ...be32(0x00010000), // version
    ...be32(0x00010000), // fontRevision
    ...be32(0), // checkSumAdjustment (patched later)
    ...be32(0x5f0f3cf5), // magicNumber
    ...be16(0), // flags
    ...be16(UPM), // unitsPerEm
    ...be32(0), ...be32(0), // created
    ...be32(0), ...be32(0), // modified
    ...s16(100), ...s16(0), ...s16(700), ...s16(700), // bbox
    ...be16(0), // macStyle
    ...be16(8), // lowestRecPPEM
    ...s16(2), // fontDirectionHint
    ...s16(1), // indexToLocFormat = long
    ...s16(0), // glyphDataFormat
  ])

  const hhea = pad4([
    ...be32(0x00010000),
    ...s16(800), ...s16(-200), ...s16(0), // ascender, descender, lineGap
    ...be16(700), // advanceWidthMax (offset 10)
    // offsets 12..31: minLSB, minRSB, xMaxExtent, caretSlopeRise/Run/Offset,
    // reserved1..4 — exactly 10 int16.
    ...s16(0), ...s16(0), ...s16(0), ...s16(0), ...s16(0),
    ...s16(0), ...s16(0), ...s16(0), ...s16(0), ...s16(0),
    ...s16(0), // metricDataFormat (offset 32)
    ...be16(4), // numberOfHMetrics (offset 34)
  ])

  // hmtx: 4 (advance, lsb) pairs.
  const hmtx = pad4([
    ...be16(0), ...s16(0), // gid0 .notdef
    ...be16(600), ...s16(100), // gid1 'H'
    ...be16(300), ...s16(100), // gid2 'i'
    ...be16(250), ...s16(0), // gid3 space
  ])

  const maxp = pad4([
    ...be32(0x00010000),
    ...be16(4), // numGlyphs
    ...be16(4), ...be16(1), ...be16(0), ...be16(0), ...be16(0), ...be16(0),
    ...be16(0), ...be16(0), ...be16(0), ...be16(1), ...be16(0), ...be16(0),
    ...be16(0),
  ])

  // cmap format 4: ' '→3, 'H'→1, 'i'→2, terminator 0xFFFF→0.
  const endCode = [0x20, 0x48, 0x69, 0xffff]
  const startCode = [0x20, 0x48, 0x69, 0xffff]
  const idDelta = [(3 - 0x20) & 0xffff, (1 - 0x48) & 0xffff, (2 - 0x69) & 0xffff, 1]
  const sub4: number[] = []
  sub4.push(...be16(4)) // format
  sub4.push(...be16(48)) // length
  sub4.push(...be16(0)) // language
  sub4.push(...be16(8)) // segCountX2
  sub4.push(...be16(8), ...be16(2), ...be16(0)) // searchRange, entrySelector, rangeShift
  for (const e of endCode) sub4.push(...be16(e))
  sub4.push(...be16(0)) // reservedPad
  for (const sC of startCode) sub4.push(...be16(sC))
  for (const d of idDelta) sub4.push(...be16(d))
  for (let i = 0; i < 4; i++) sub4.push(...be16(0)) // idRangeOffset
  const cmap = pad4([
    ...be16(0), // version
    ...be16(1), // numTables
    ...be16(3), ...be16(1), ...be32(12), // (3,1) → subtable at offset 12
    ...sub4,
  ])

  const nameStr: number[] = []
  for (const ch of 'SynthSans') nameStr.push(...be16(ch.charCodeAt(0)))
  const name = pad4([
    ...be16(0), // format
    ...be16(1), // count
    ...be16(18), // stringOffset (6 + 12)
    ...be16(3), ...be16(1), ...be16(0x0409), ...be16(6), // platform/enc/lang/nameID=6
    ...be16(nameStr.length), ...be16(0), // length, offset
    ...nameStr,
  ])

  const post = pad4([
    ...be32(0x00030000), // version 3.0 (no glyph names)
    ...be32(0), // italicAngle
    ...s16(-100), ...s16(50), // underlinePosition, underlineThickness
    ...be32(0), // isFixedPitch
    ...be32(0), ...be32(0), ...be32(0), ...be32(0), // mem usage
  ])

  const os2 = pad4([
    ...be16(4), // version
    ...s16(500), // xAvgCharWidth
    ...be16(400), // usWeightClass
    ...be16(5), // usWidthClass
    ...be16(0), // fsType
    ...s16(650), ...s16(0), ...s16(700), ...s16(0), // subscript
    ...s16(0), ...s16(0), ...s16(0), ...s16(0), // superscript
    ...s16(50), ...s16(300), // strikeout
    ...s16(0), // sFamilyClass
    ...new Array(10).fill(0), // panose
    ...be32(0), ...be32(0), ...be32(0), ...be32(0), // unicode ranges
    0x54, 0x45, 0x53, 0x54, // achVendID 'TEST'
    ...be16(0x40), // fsSelection = REGULAR
    ...be16(0x20), ...be16(0x7a), // first/last char
    ...s16(800), ...s16(-200), ...s16(0), // typo ascender/descender/linegap
    ...be16(900), ...be16(200), // win ascent/descent
    ...be32(0), ...be32(0), // codepage ranges
    ...s16(500), ...s16(700), // sxHeight, sCapHeight
    ...be16(0), ...be16(0), ...be16(0), // default/break/maxContext
  ])

  const tables: { tag: string; data: number[] }[] = [
    { tag: 'OS/2', data: os2 },
    { tag: 'cmap', data: cmap },
    { tag: 'glyf', data: glyf },
    { tag: 'head', data: head },
    { tag: 'hhea', data: hhea },
    { tag: 'hmtx', data: hmtx },
    { tag: 'loca', data: pad4(loca) },
    { tag: 'maxp', data: maxp },
    { tag: 'name', data: name },
    { tag: 'post', data: post },
  ].sort((a, b) => (a.tag < b.tag ? -1 : 1))

  const numTables = tables.length
  const headerLen = 12 + numTables * 16
  let cursor = headerLen
  const placed = tables.map(t => {
    const rec = { ...t, offset: cursor }
    cursor += t.data.length
    return rec
  })

  const out: number[] = []
  out.push(...be32(0x00010000)) // sfnt version
  out.push(...be16(numTables), ...be16(128), ...be16(3), ...be16(160 - 128))
  for (const t of placed) {
    for (let i = 0; i < 4; i++) out.push(t.tag.charCodeAt(i))
    out.push(...be32(checksum(t.data)))
    out.push(...be32(t.offset))
    out.push(...be32(t.tag === 'loca' ? loca.length : t.tag === 'glyf' ? glyf.length : t.data.length))
  }
  for (const t of placed) out.push(...t.data)

  // Patch head.checkSumAdjustment = 0xB1B0AFBA − checksum(whole file).
  const headRec = placed.find(t => t.tag === 'head')!
  const adj = (0xb1b0afba - checksum(out)) >>> 0
  const a8 = headRec.offset + 8
  out[a8] = (adj >>> 24) & 0xff
  out[a8 + 1] = (adj >>> 16) & 0xff
  out[a8 + 2] = (adj >>> 8) & 0xff
  out[a8 + 3] = adj & 0xff

  return Uint8Array.from(out)
}
