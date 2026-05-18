/**
 * Single-byte text encodings (spec §D) for the read side, plus a glyph-name →
 * Unicode resolver (Adobe Glyph List subset + the algorithmic `uniXXXX` /
 * `uXXXXXX` forms). Used when a simple font has no `/ToUnicode`: the base
 * encoding maps code → glyph name → Unicode.
 *
 * WinAnsi is implemented exactly (it is what the writer emits for Standard-14
 * and the common case for simple fonts). Standard/MacRoman/PDFDoc share
 * WinAnsi for ASCII and Latin-1 and only differ in the punctuation high range;
 * those differences are approximated and documented as a v1 limitation.
 */

// CP1252-specific code points in 0x80–0x9F; everything else in 0x20–0xFF maps
// to the same Unicode scalar (Latin-1) and 0x00–0x1F to itself.
const WIN_HIGH: Record<number, number> = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026,
  0x86: 0x2020, 0x87: 0x2021, 0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160,
  0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018, 0x92: 0x2019,
  0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014,
  0x98: 0x02dc, 0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153,
  0x9e: 0x017e, 0x9f: 0x0178,
}

export function winAnsiToUnicode(code: number): number {
  if (code >= 0x80 && code <= 0x9f) return WIN_HIGH[code] ?? code
  return code // ASCII + Latin-1 are identity
}

export type BaseEncodingName =
  | 'WinAnsiEncoding'
  | 'MacRomanEncoding'
  | 'StandardEncoding'
  | 'PDFDocEncoding'
  | 'MacExpertEncoding'

/** Resolve a code under a named base encoding (approximate for non-WinAnsi). */
export function baseEncode(name: BaseEncodingName | undefined, code: number): number {
  // WinAnsi is exact; others are close enough for ASCII/Latin text. Glyph-name
  // /Differences (handled by the caller) override anything that matters.
  return winAnsiToUnicode(code)
}

// A pragmatic Adobe Glyph List subset: ASCII + the common Latin-1 names the
// writer and typical producers emit via /Differences. Extend as needed.
const AGL: Record<string, number> = {
  space: 0x20, exclam: 0x21, quotedbl: 0x22, numbersign: 0x23, dollar: 0x24,
  percent: 0x25, ampersand: 0x26, quotesingle: 0x27, parenleft: 0x28,
  parenright: 0x29, asterisk: 0x2a, plus: 0x2b, comma: 0x2c, hyphen: 0x2d,
  period: 0x2e, slash: 0x2f, zero: 0x30, one: 0x31, two: 0x32, three: 0x33,
  four: 0x34, five: 0x35, six: 0x36, seven: 0x37, eight: 0x38, nine: 0x39,
  colon: 0x3a, semicolon: 0x3b, less: 0x3c, equal: 0x3d, greater: 0x3e,
  question: 0x3f, at: 0x40, bracketleft: 0x5b, backslash: 0x5c,
  bracketright: 0x5d, asciicircum: 0x5e, underscore: 0x5f, grave: 0x60,
  braceleft: 0x7b, bar: 0x7c, braceright: 0x7d, asciitilde: 0x7e,
  bullet: 0x2022, endash: 0x2013, emdash: 0x2014, quoteleft: 0x2018,
  quoteright: 0x2019, quotedblleft: 0x201c, quotedblright: 0x201d,
  quotesinglbase: 0x201a, quotedblbase: 0x201e, ellipsis: 0x2026,
  dagger: 0x2020, daggerdbl: 0x2021, perthousand: 0x2030, trademark: 0x2122,
  fi: 0xfb01, fl: 0xfb02, florin: 0x192, Euro: 0x20ac, nbspace: 0xa0,
}

/** glyph name → Unicode code point, or -1 if unknown. */
export function glyphNameToUnicode(g: string): number {
  if (g in AGL) return AGL[g]!
  // Letters/digits: single-char names like "A", "z" are not standard, but
  // "uniXXXX" and "uXXXXXX" are.
  let m = /^uni([0-9A-Fa-f]{4})$/.exec(g)
  if (m) return parseInt(m[1]!, 16)
  m = /^u([0-9A-Fa-f]{4,6})$/.exec(g)
  if (m) return parseInt(m[1]!, 16)
  // "gNN" / "cidNN" / "indexNN": no Unicode information available.
  return -1
}
