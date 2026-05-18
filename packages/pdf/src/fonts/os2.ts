/**
 * `OS/2` table (spec §10.2): the metrics the PDF Font Descriptor needs
 * (cap height, weight, typographic ascender/descender, fsSelection). All
 * fields are optional — callers fall back to `hhea`/derived values.
 */

import { BinaryReader } from '../util/binary.ts'

export interface Os2Metrics {
  weightClass: number
  fsSelection: number
  sFamilyClass: number
  typoAscender: number
  typoDescender: number
  capHeight: number | null
  xHeight: number | null
}

export function parseOs2(os2: Uint8Array | undefined): Os2Metrics | null {
  if (!os2 || os2.length < 78) return null
  const r = new BinaryReader(os2)
  const version = r.u16()
  r.seek(4)
  const weightClass = r.u16()
  r.seek(30)
  const sFamilyClass = r.i16()
  r.seek(62)
  const fsSelection = r.u16()
  r.seek(68)
  const typoAscender = r.i16()
  const typoDescender = r.i16()

  let capHeight: number | null = null
  let xHeight: number | null = null
  if (version >= 2 && os2.length >= 90) {
    r.seek(86)
    xHeight = r.i16()
    capHeight = r.i16()
  }
  return { weightClass, fsSelection, sFamilyClass, typoAscender, typoDescender, capHeight, xHeight }
}
