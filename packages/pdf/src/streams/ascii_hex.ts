/**
 * ASCIIHexDecode (spec §7.1). Available; not used by default. Each byte → two
 * uppercase hex digits, terminated by the `>` EOD marker.
 */

const HEX = '0123456789ABCDEF'

export function asciiHexEncode(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length * 2 + 1)
  let i = 0
  for (const b of data) {
    out[i++] = HEX.charCodeAt(b >> 4)
    out[i++] = HEX.charCodeAt(b & 0x0f)
  }
  out[i] = 0x3e // >
  return out
}

export function asciiHexDecode(data: Uint8Array): Uint8Array {
  const nibbles: number[] = []
  for (const b of data) {
    if (b === 0x3e) break // > EOD
    if (b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d || b === 0x0c) continue
    const c = String.fromCharCode(b)
    const v = parseInt(c, 16)
    if (Number.isNaN(v)) throw new Error(`Invalid ASCIIHex digit: ${c}`)
    nibbles.push(v)
  }
  if (nibbles.length % 2 === 1) nibbles.push(0) // odd → last nibble is 0
  const out = new Uint8Array(nibbles.length / 2)
  for (let j = 0; j < out.length; j++) out[j] = (nibbles[2 * j]! << 4) | nibbles[2 * j + 1]!
  return out
}
