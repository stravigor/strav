/**
 * WinAnsiEncoding (spec §10.4) — the encoding used for Standard-14 simple
 * text fonts. It is Latin-1 except for the 0x80–0x9F band, which holds the
 * CP1252 printable characters instead of C1 controls.
 *
 * `encodeWinAnsi` maps a JS string (iterated by code point) to the single-byte
 * sequence that goes inside a PDF `(...)` / `<...>` string for `Tj`/`TJ`.
 * Unrepresentable characters throw — silent substitution corrupts text.
 */

import { PdfGenError } from '../util/errors.ts'

/** Unicode code point → byte for the CP1252 0x80–0x9F band. */
const CP1252_HIGH: ReadonlyArray<[number, number]> = [
  [0x20ac, 0x80], // €
  [0x201a, 0x82], // ‚
  [0x0192, 0x83], // ƒ
  [0x201e, 0x84], // „
  [0x2026, 0x85], // …
  [0x2020, 0x86], // †
  [0x2021, 0x87], // ‡
  [0x02c6, 0x88], // ˆ
  [0x2030, 0x89], // ‰
  [0x0160, 0x8a], // Š
  [0x2039, 0x8b], // ‹
  [0x0152, 0x8c], // Œ
  [0x017d, 0x8e], // Ž
  [0x2018, 0x91], // ‘
  [0x2019, 0x92], // ’
  [0x201c, 0x93], // “
  [0x201d, 0x94], // ”
  [0x2022, 0x95], // •
  [0x2013, 0x96], // –
  [0x2014, 0x97], // —
  [0x02dc, 0x98], // ˜
  [0x2122, 0x99], // ™
  [0x0161, 0x9a], // š
  [0x203a, 0x9b], // ›
  [0x0153, 0x9c], // œ
  [0x017e, 0x9e], // ž
  [0x0178, 0x9f], // Ÿ
]

const HIGH = new Map<number, number>(CP1252_HIGH)

/** Map one Unicode code point to its WinAnsi byte, or `null` if unmappable. */
export function winAnsiByte(cp: number): number | null {
  // ASCII and the Latin-1 upper half map identically.
  if ((cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff)) return cp
  return HIGH.get(cp) ?? null
}

/** Encode a string to WinAnsi bytes; throws on the first unmappable char. */
export function encodeWinAnsi(text: string): Uint8Array {
  const out: number[] = []
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    const b = winAnsiByte(cp)
    if (b === null) {
      throw new PdfGenError(
        'PDF_TEXT_ENCODING',
        `U+${cp.toString(16).toUpperCase().padStart(4, '0')} (${JSON.stringify(ch)}) ` +
          'is not representable in WinAnsiEncoding; embed a Unicode font (milestone 5)'
      )
    }
    out.push(b)
  }
  return Uint8Array.from(out)
}
