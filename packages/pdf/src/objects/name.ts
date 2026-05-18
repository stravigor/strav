/**
 * Name token escaping (spec §5.1).
 *
 * A name is written as `/` followed by its characters. Any byte outside the
 * regular range `! (0x21) … ~ (0x7e)`, plus the delimiters and `#` itself,
 * is written as `#XX` (two uppercase hex digits).
 */

import { ascii, concatBytes } from '../util/ascii.ts'

const HEX = '0123456789ABCDEF'

function needsEscape(b: number): boolean {
  if (b < 0x21 || b > 0x7e) return true
  switch (b) {
    case 0x23: // #
    case 0x28: // (
    case 0x29: // )
    case 0x3c: // <
    case 0x3e: // >
    case 0x5b: // [
    case 0x5d: // ]
    case 0x7b: // {
    case 0x7d: // }
    case 0x2f: // /
    case 0x25: // %
      return true
    default:
      return false
  }
}

/** Encode a name's value (without the leading `/`) to escaped bytes. */
export function encodeName(value: string): Uint8Array {
  const src = ascii(value)
  const parts: Uint8Array[] = []
  let runStart = 0

  for (let i = 0; i < src.length; i++) {
    const b = src[i]!
    if (needsEscape(b)) {
      if (i > runStart) parts.push(src.subarray(runStart, i))
      parts.push(Uint8Array.from([0x23, HEX.charCodeAt(b >> 4), HEX.charCodeAt(b & 0x0f)]))
      runStart = i + 1
    }
  }
  if (runStart < src.length) parts.push(src.subarray(runStart))

  return concatBytes([Uint8Array.from([0x2f]), ...parts]) // leading '/'
}
