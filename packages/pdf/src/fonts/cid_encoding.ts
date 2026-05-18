/**
 * Identity-H CID encoding helpers (spec §10.5). With Identity-H the CID equals
 * the glyph index and codes are 2-byte big-endian. This builds the `/W` width
 * array (compact consecutive runs) keyed by CID.
 */

import { arr, num } from '../objects/types.ts'
import type { PdfArray } from '../objects/types.ts'

/** Encode a glyph-index sequence as 2-byte big-endian codes. */
export function encodeIdentityH(gids: number[]): Uint8Array {
  const out = new Uint8Array(gids.length * 2)
  for (let i = 0; i < gids.length; i++) {
    out[i * 2] = (gids[i]! >> 8) & 0xff
    out[i * 2 + 1] = gids[i]! & 0xff
  }
  return out
}

/**
 * Build the CIDFont `/W` array for the used glyphs. Scales font-unit advances
 * to PDF glyph space (1000-unit em). Consecutive CIDs collapse to the
 * `c [w1 w2 …]` form: `[ c0 [w w w] c5 [w] … ]`.
 */
export function buildWidthsArray(
  usedGids: number[],
  advanceFontUnits: (gid: number) => number,
  unitsPerEm: number
): PdfArray {
  const sorted = [...new Set(usedGids)].sort((a, b) => a - b)
  const scale = 1000 / unitsPerEm
  const items = []
  for (let i = 0; i < sorted.length; ) {
    const start = sorted[i]!
    const run: number[] = [Math.round(advanceFontUnits(start) * scale)]
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) {
      j++
      run.push(Math.round(advanceFontUnits(sorted[j]!) * scale))
    }
    items.push(num(start), arr(run.map(num)))
    i = j + 1
  }
  return arr(items)
}
