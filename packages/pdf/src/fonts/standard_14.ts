/**
 * The Standard-14 fonts (spec §10.1). Referenced only — never embedded; the
 * viewer is assumed to have them. Under a conformance mode they are rejected
 * (enforced in `PdfDocument`); embedded fonts arrive in milestone 5.
 *
 * Width tables are the canonical Adobe Core-14 AFM metrics (units per 1000 em)
 * for the printable ASCII range (codes 32–126). We do **not** emit a `/Widths`
 * array for Standard-14 fonts (the viewer supplies metrics), so these are used
 * only by the optional `PdfFont.widthOfText()` helper. Metrics for the
 * non-ASCII WinAnsi range are approximated by a per-font default and refined
 * in a later milestone — rendering is unaffected.
 */

export type StandardFontName =
  | 'Helvetica'
  | 'Helvetica-Bold'
  | 'Helvetica-Oblique'
  | 'Helvetica-BoldOblique'
  | 'Times-Roman'
  | 'Times-Bold'
  | 'Times-Italic'
  | 'Times-BoldItalic'
  | 'Courier'
  | 'Courier-Bold'
  | 'Courier-Oblique'
  | 'Courier-BoldOblique'
  | 'Symbol'
  | 'ZapfDingbats'

// Widths for codes 32..126 (index = code - 32).
const HELVETICA = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278,
  278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584,
  584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556,
  833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278,
  278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222,
  500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500,
  500, 334, 260, 334, 584,
]

const HELVETICA_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278,
  278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584,
  584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611,
  833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333,
  278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278,
  556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556,
  500, 389, 280, 389, 584,
]

const TIMES_ROMAN = [
  250, 333, 408, 500, 500, 833, 778, 180, 333, 333, 500, 564, 250, 333, 250,
  278, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 278, 278, 564, 564,
  564, 444, 921, 722, 667, 667, 722, 611, 556, 722, 722, 333, 389, 722, 611,
  889, 722, 722, 556, 722, 667, 556, 611, 722, 722, 944, 722, 722, 611, 333,
  278, 333, 469, 500, 333, 444, 500, 444, 500, 444, 333, 500, 500, 278, 278,
  500, 278, 778, 500, 500, 500, 500, 333, 389, 278, 500, 500, 722, 500, 500,
  444, 480, 200, 480, 541,
]

const TIMES_BOLD = [
  250, 333, 555, 500, 500, 1000, 833, 278, 333, 333, 500, 570, 250, 333, 250,
  278, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 333, 333, 570, 570,
  570, 500, 930, 722, 667, 722, 722, 667, 611, 778, 778, 389, 500, 778, 667,
  944, 722, 778, 611, 778, 722, 556, 667, 722, 722, 1000, 722, 722, 667, 333,
  278, 333, 581, 500, 333, 500, 556, 444, 556, 444, 333, 500, 556, 278, 333,
  556, 278, 833, 556, 500, 556, 556, 444, 389, 333, 556, 500, 722, 500, 500,
  444, 394, 220, 394, 520,
]

const TIMES_ITALIC = [
  250, 333, 420, 500, 500, 833, 778, 214, 333, 333, 500, 675, 250, 333, 250,
  278, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 333, 333, 675, 675,
  675, 500, 920, 611, 611, 667, 722, 611, 611, 722, 722, 333, 444, 667, 556,
  833, 667, 722, 611, 722, 611, 500, 556, 722, 611, 833, 611, 556, 556, 389,
  278, 389, 422, 500, 333, 500, 500, 444, 500, 444, 278, 500, 500, 278, 278,
  444, 278, 722, 500, 500, 500, 500, 389, 389, 278, 500, 444, 667, 444, 444,
  389, 400, 275, 400, 541,
]

const TIMES_BOLD_ITALIC = [
  250, 389, 555, 500, 500, 833, 778, 278, 333, 333, 500, 570, 250, 333, 250,
  278, 500, 500, 500, 500, 500, 500, 500, 500, 500, 500, 333, 333, 570, 570,
  570, 500, 832, 667, 667, 667, 722, 667, 667, 722, 778, 389, 500, 667, 611,
  889, 722, 722, 611, 722, 667, 556, 611, 722, 667, 889, 667, 611, 611, 333,
  278, 333, 570, 500, 333, 500, 500, 444, 500, 444, 333, 500, 556, 278, 278,
  500, 278, 778, 556, 500, 500, 500, 389, 389, 278, 556, 444, 667, 500, 444,
  389, 348, 220, 348, 570,
]

const COURIER_WIDTH = 600 // monospaced — every glyph

interface FontMeta {
  /** ASCII 32..126 width table, or null for monospaced/symbolic. */
  ascii: number[] | null
  /** Width for codes outside 32..126 (and the symbolic fonts). */
  fallback: number
  /** WinAnsiEncoding applies (text fonts); Symbol/ZapfDingbats use built-in. */
  winAnsi: boolean
}

const META: Record<StandardFontName, FontMeta> = {
  Helvetica: { ascii: HELVETICA, fallback: 556, winAnsi: true },
  'Helvetica-Oblique': { ascii: HELVETICA, fallback: 556, winAnsi: true },
  'Helvetica-Bold': { ascii: HELVETICA_BOLD, fallback: 611, winAnsi: true },
  'Helvetica-BoldOblique': { ascii: HELVETICA_BOLD, fallback: 611, winAnsi: true },
  'Times-Roman': { ascii: TIMES_ROMAN, fallback: 500, winAnsi: true },
  'Times-Bold': { ascii: TIMES_BOLD, fallback: 500, winAnsi: true },
  'Times-Italic': { ascii: TIMES_ITALIC, fallback: 500, winAnsi: true },
  'Times-BoldItalic': { ascii: TIMES_BOLD_ITALIC, fallback: 500, winAnsi: true },
  Courier: { ascii: null, fallback: COURIER_WIDTH, winAnsi: true },
  'Courier-Bold': { ascii: null, fallback: COURIER_WIDTH, winAnsi: true },
  'Courier-Oblique': { ascii: null, fallback: COURIER_WIDTH, winAnsi: true },
  'Courier-BoldOblique': { ascii: null, fallback: COURIER_WIDTH, winAnsi: true },
  Symbol: { ascii: null, fallback: 600, winAnsi: false },
  ZapfDingbats: { ascii: null, fallback: 600, winAnsi: false },
}

export function isStandardFontName(name: string): name is StandardFontName {
  return name in META
}

export function usesWinAnsi(name: StandardFontName): boolean {
  return META[name].winAnsi
}

/** Glyph width in 1000-em units for a WinAnsi byte (0–255). */
export function standardGlyphWidth(name: StandardFontName, byte: number): number {
  const m = META[name]
  if (m.ascii && byte >= 32 && byte <= 126) return m.ascii[byte - 32]!
  return m.fallback
}
