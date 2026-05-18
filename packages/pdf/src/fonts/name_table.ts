/**
 * `name` table (spec §10.2). We only need the PostScript name (nameID 6) for
 * `/BaseFont`; family (1) is read as a fallback.
 */

import { BinaryReader } from '../util/binary.ts'

function decode(bytes: Uint8Array, platformId: number): string {
  // Windows (3) and Unicode (0) are UTF-16BE; Mac (1) is ASCII-ish.
  if (platformId === 1) {
    let s = ''
    for (const b of bytes) s += String.fromCharCode(b)
    return s
  }
  let s = ''
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    s += String.fromCharCode((bytes[i]! << 8) | bytes[i + 1]!)
  }
  return s
}

export interface FontNames {
  postScriptName: string | null
  family: string | null
}

export function parseName(name: Uint8Array): FontNames {
  const r = new BinaryReader(name)
  r.u16() // format
  const count = r.u16()
  const stringOffset = r.u16()

  let postScriptName: string | null = null
  let family: string | null = null

  for (let i = 0; i < count; i++) {
    const platformId = r.u16()
    r.u16() // encodingId
    r.u16() // languageId
    const nameId = r.u16()
    const length = r.u16()
    const offset = r.u16()
    if (nameId !== 6 && nameId !== 1) continue
    const start = stringOffset + offset
    const value = decode(name.subarray(start, start + length), platformId)
    if (nameId === 6 && !postScriptName) postScriptName = value
    if (nameId === 1 && !family) family = value
  }
  return { postScriptName, family }
}
