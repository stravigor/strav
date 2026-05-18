/**
 * ASCII byte helpers. PDF tokens are ASCII; we work at the byte level to keep
 * serialization deterministic and free of platform text-encoding surprises.
 */

const encoder = new TextEncoder()

/** Encode an ASCII/Latin-1 string to bytes. Throws on non-Latin-1 input. */
export function ascii(s: string): Uint8Array {
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c > 0xff) {
      throw new Error(`Non-Latin-1 character at index ${i}: U+${c.toString(16)}`)
    }
    out[i] = c
  }
  return out
}

/** Encode a string as UTF-8 bytes (used for XMP, ToUnicode CMap text, etc.). */
export function utf8(s: string): Uint8Array {
  return encoder.encode(s)
}

/** Concatenate byte chunks into a single Uint8Array. */
export function concatBytes(chunks: readonly Uint8Array[]): Uint8Array {
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Uint8Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

// Common single bytes used by the encoder.
export const SPACE = 0x20
export const LF = 0x0a
export const CR = 0x0d

/** True for PDF whitespace bytes (ISO 32000-1 Table 1). */
export function isWhitespace(b: number): boolean {
  return b === 0x00 || b === 0x09 || b === 0x0a || b === 0x0c || b === 0x0d || b === 0x20
}

/** True for PDF delimiter bytes (ISO 32000-1 Table 2). */
export function isDelimiter(b: number): boolean {
  return (
    b === 0x28 || // (
    b === 0x29 || // )
    b === 0x3c || // <
    b === 0x3e || // >
    b === 0x5b || // [
    b === 0x5d || // ]
    b === 0x7b || // {
    b === 0x7d || // }
    b === 0x2f || // /
    b === 0x25 // %
  )
}
