/**
 * `PdfFont` (spec §10, §16). The public font handle. Milestone 4 ships the
 * Standard-14 referenced fonts; `PdfFont.fromTrueType(...)` and subsetting are
 * milestones 5–7 and will extend this same abstract surface.
 */

import { PdfGenError } from '../util/errors.ts'
import { dict, name } from '../objects/types.ts'
import type { PdfDictionary } from '../objects/types.ts'
import { encodeWinAnsi } from './win_ansi.ts'
import {
  type StandardFontName,
  isStandardFontName,
  standardGlyphWidth,
  usesWinAnsi,
} from './standard_14.ts'

export type { StandardFontName }

export abstract class PdfFont {
  /** Stable identity — used for resource dedupe (and subset tags in M6). */
  abstract readonly id: string
  /** PDF `/BaseFont` name. */
  abstract readonly baseFont: string
  /** True for Standard-14 (rejected under PDF/A and PDF/X). */
  abstract readonly isStandard14: boolean

  /** Encode a string into the bytes that go inside a `Tj`/`TJ` string. */
  abstract encode(text: string): Uint8Array

  /** Rendered width of `text` in points at `sizePt`. */
  abstract widthOfText(text: string, sizePt: number): number

  /** Build the `/Font` dictionary for the page resource map. */
  abstract toFontDictionary(): PdfDictionary

  /** Reference one of the Standard-14 fonts (never embedded, spec §10.1). */
  static standard(fontName: StandardFontName): PdfFont {
    return new Standard14Font(fontName)
  }
}

class Standard14Font extends PdfFont {
  readonly id: string
  readonly baseFont: string
  readonly isStandard14 = true
  private readonly winAnsi: boolean

  constructor(private readonly fontName: StandardFontName) {
    super()
    if (!isStandardFontName(fontName)) {
      throw new PdfGenError('PDF_UNSUPPORTED_FONT', `Unknown Standard-14 font: ${fontName}`)
    }
    this.baseFont = fontName
    this.id = `std14:${fontName}`
    this.winAnsi = usesWinAnsi(fontName)
  }

  encode(text: string): Uint8Array {
    if (this.winAnsi) return encodeWinAnsi(text)
    // Symbol / ZapfDingbats use their built-in encoding: the caller supplies
    // bytes already in that encoding (single-byte, code = char code).
    const out = new Uint8Array(text.length)
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i)
      if (c > 0xff) {
        throw new PdfGenError(
          'PDF_TEXT_ENCODING',
          `${this.baseFont} uses a built-in 8-bit encoding; char U+${c.toString(16)} is out of range`
        )
      }
      out[i] = c
    }
    return out
  }

  widthOfText(text: string, sizePt: number): number {
    let units = 0
    for (const byte of this.encode(text)) {
      units += standardGlyphWidth(this.fontName, byte)
    }
    return (units * sizePt) / 1000
  }

  toFontDictionary(): PdfDictionary {
    const entries = dict({
      Type: name('Font'),
      Subtype: name('Type1'),
      BaseFont: name(this.baseFont),
    })
    // WinAnsiEncoding for the text fonts; Symbol/ZapfDingbats omit /Encoding
    // and use their built-in encoding (spec §10.1).
    if (this.winAnsi) entries.entries.set('Encoding', name('WinAnsiEncoding'))
    return entries
  }
}
