/**
 * Minimal CFF (`CFF `) table parsing (spec §10.1, Adobe TN #5176).
 *
 * Milestone 7 embeds the CFF program **whole** (CFF subsetting is deferred per
 * spec §23 decision 1), so we only need: the PostScript name, whether the CFF
 * is CID-keyed, and the glyph count (CharStrings INDEX count). Charstring
 * outline interpretation is out of scope until CFF subsetting lands.
 */

export interface CffInfo {
  /** PostScript name from the Name INDEX. */
  name: string
  /** True if the Top DICT has a ROS operator (CID-keyed CFF). */
  isCID: boolean
  /** Number of glyphs (CharStrings INDEX count). */
  numGlyphs: number
}

interface IndexResult {
  items: Uint8Array[]
  /** Byte offset just past this INDEX. */
  end: number
}

function readOffset(b: Uint8Array, pos: number, size: number): number {
  let v = 0
  for (let i = 0; i < size; i++) v = (v << 8) | b[pos + i]!
  return v >>> 0
}

/** Read a CFF INDEX at `pos`. */
function readIndex(b: Uint8Array, pos: number): IndexResult {
  const count = (b[pos]! << 8) | b[pos + 1]!
  if (count === 0) return { items: [], end: pos + 2 }
  const offSize = b[pos + 2]!
  const offArr = pos + 3
  const dataBase = offArr + (count + 1) * offSize - 1
  const items: Uint8Array[] = []
  for (let i = 0; i < count; i++) {
    const start = readOffset(b, offArr + i * offSize, offSize)
    const next = readOffset(b, offArr + (i + 1) * offSize, offSize)
    items.push(b.subarray(dataBase + start, dataBase + next))
  }
  const end = dataBase + readOffset(b, offArr + count * offSize, offSize)
  return { items, end }
}

/** Parse a Top DICT, returning the CharStrings offset and CID-keyed flag. */
function parseTopDict(d: Uint8Array): { charStrings: number; isCID: boolean } {
  let charStrings = 0
  let isCID = false
  const operands: number[] = []
  let i = 0
  while (i < d.length) {
    const b0 = d[i]!
    if (b0 <= 21) {
      // Operator (12 = escape → two-byte operator).
      if (b0 === 12) {
        const op2 = d[i + 1]!
        if (op2 === 30) isCID = true // ROS
        i += 2
      } else {
        if (b0 === 17) charStrings = operands[operands.length - 1] ?? 0 // CharStrings
        i += 1
      }
      operands.length = 0
    } else if (b0 === 28) {
      operands.push(((d[i + 1]! << 8) | d[i + 2]!) << 16 >> 16)
      i += 3
    } else if (b0 === 29) {
      operands.push(
        ((d[i + 1]! << 24) | (d[i + 2]! << 16) | (d[i + 3]! << 8) | d[i + 4]!) | 0
      )
      i += 5
    } else if (b0 === 30) {
      // Real number: BCD nibbles until 0xf terminator.
      i += 1
      while (i < d.length) {
        const hi = d[i]! >> 4
        const lo = d[i]! & 0xf
        i += 1
        if (hi === 0xf || lo === 0xf) break
      }
      operands.push(0)
    } else if (b0 >= 32 && b0 <= 246) {
      operands.push(b0 - 139)
      i += 1
    } else if (b0 >= 247 && b0 <= 250) {
      operands.push((b0 - 247) * 256 + d[i + 1]! + 108)
      i += 2
    } else if (b0 >= 251 && b0 <= 254) {
      operands.push(-(b0 - 251) * 256 - d[i + 1]! - 108)
      i += 2
    } else {
      i += 1 // reserved (22..27, 31, 255) — skip defensively
    }
  }
  return { charStrings, isCID }
}

export function parseCff(cff: Uint8Array): CffInfo {
  const hdrSize = cff[2]!
  const nameIdx = readIndex(cff, hdrSize)
  const topIdx = readIndex(cff, nameIdx.end)

  const first = nameIdx.items[0]
  let name = 'CFFFont'
  if (first) {
    let s = ''
    for (const ch of first) s += String.fromCharCode(ch)
    name = s
  }

  const top = topIdx.items[0]
  if (!top) return { name, isCID: false, numGlyphs: 0 }
  const { charStrings, isCID } = parseTopDict(top)

  let numGlyphs = 0
  if (charStrings > 0 && charStrings + 2 <= cff.length) {
    numGlyphs = (cff[charStrings]! << 8) | cff[charStrings + 1]!
  }
  return { name, isCID, numGlyphs }
}
