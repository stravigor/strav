/**
 * PDF strings (spec §5.1).
 *
 * A {@link PdfString} stores raw bytes plus a serialization hint. This module
 * provides:
 *  - constructors that turn JS strings / dates into the right byte sequence
 *    (UTF-16BE with BOM by default for text strings, PDFDocEncoding opt-in);
 *  - the literal and hex serializers used by objects/encode.ts.
 */

import { PdfGenError } from '../util/errors.ts'
import { ascii } from '../util/ascii.ts'
import type { PdfString } from './types.ts'

// ── Constructors ──────────────────────────────────────────────────────────

/** A string from raw bytes, serialized as a literal `( )` string. */
export function literalBytes(value: Uint8Array): PdfString {
  return { kind: 'str', value, encoding: 'literal' }
}

/** A string from raw bytes, serialized as a hex `< >` string. */
export function hexBytes(value: Uint8Array): PdfString {
  return { kind: 'str', value, encoding: 'hex' }
}

/**
 * A human-readable "text string". Defaults to UTF-16BE with a leading
 * `\xFE\xFF` BOM (PDF's text-string convention). With `encoding:'pdfdoc'`,
 * characters must be representable in a single byte (Latin-1 subset of
 * PDFDocEncoding) and are written verbatim.
 */
export function textString(
  s: string,
  opts: { encoding?: 'utf16be' | 'pdfdoc' } = {}
): PdfString {
  if (opts.encoding === 'pdfdoc') {
    const out = new Uint8Array(s.length)
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i)
      if (c > 0xff) {
        throw new PdfGenError(
          'PDF_INVALID_STRING',
          `Character U+${c.toString(16)} not representable in PDFDocEncoding; use UTF-16BE`
        )
      }
      out[i] = c
    }
    return { kind: 'str', value: out, encoding: 'literal' }
  }

  // UTF-16BE with BOM. Iterate code points so astral chars become surrogate
  // pairs (two 16-bit units), which is the correct UTF-16 representation.
  const units: number[] = [0xfe, 0xff]
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i)
    units.push(code >> 8, code & 0xff)
  }
  return { kind: 'str', value: Uint8Array.from(units), encoding: 'hex' }
}

/**
 * A PDF date string: `D:YYYYMMDDHHmmSSOHH'mm'` (ISO 32000-1 §7.9.4).
 * Always UTC (`Z`-equivalent rendered as `+00'00'`) for determinism.
 */
export function dateString(date: Date): PdfString {
  const p = (n: number, w = 2) => String(n).padStart(w, '0')
  const s =
    `D:${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}+00'00'`
  return { kind: 'str', value: ascii(s), encoding: 'literal' }
}

// ── Serializers ───────────────────────────────────────────────────────────

const HEX = '0123456789ABCDEF'

/** Serialize bytes as a literal string `( ... )` with the minimal escaping. */
export function encodeLiteral(value: Uint8Array): Uint8Array {
  const out: number[] = [0x28] // (
  for (const b of value) {
    switch (b) {
      case 0x5c: // backslash
        out.push(0x5c, 0x5c)
        break
      case 0x28: // (
        out.push(0x5c, 0x28)
        break
      case 0x29: // )
        out.push(0x5c, 0x29)
        break
      case 0x0a: // \n
        out.push(0x5c, 0x6e)
        break
      case 0x0d: // \r
        out.push(0x5c, 0x72)
        break
      case 0x09: // \t
        out.push(0x5c, 0x74)
        break
      case 0x08: // \b
        out.push(0x5c, 0x62)
        break
      case 0x0c: // \f
        out.push(0x5c, 0x66)
        break
      default:
        if (b < 0x20 || b > 0x7e) {
          // Octal escape \ddd for non-printable / high bytes.
          out.push(
            0x5c,
            0x30 + ((b >> 6) & 0x7),
            0x30 + ((b >> 3) & 0x7),
            0x30 + (b & 0x7)
          )
        } else {
          out.push(b)
        }
    }
  }
  out.push(0x29) // )
  return Uint8Array.from(out)
}

/** Serialize bytes as a hex string `<...>`. */
export function encodeHex(value: Uint8Array): Uint8Array {
  const out = new Uint8Array(value.length * 2 + 2)
  out[0] = 0x3c // <
  let i = 1
  for (const b of value) {
    out[i++] = HEX.charCodeAt(b >> 4)
    out[i++] = HEX.charCodeAt(b & 0x0f)
  }
  out[i] = 0x3e // >
  return out
}
