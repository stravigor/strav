/**
 * `PdfFont` (spec §10, §16). The public font handle.
 *
 * - `PdfFont.standard(name)` — a Standard-14 referenced font (never embedded).
 * - `PdfFont.fromTrueType(bytes)` — a fully-embedded TrueType font emitted as
 *   a Type0 / CIDFontType2 with Identity-H encoding and a ToUnicode CMap
 *   (selectable, copy/pasteable text). Subsetting is milestone 6.
 *
 * A font registers itself into the object table via `register(table)`, which
 * adds however many indirect objects it needs and returns the `/Font` ref to
 * place in the page resource dictionary.
 */

import { PdfGenError, UnsupportedFontError } from '../util/errors.ts'
import { ascii } from '../util/ascii.ts'
import { arr, dict, name, num } from '../objects/types.ts'
import type { IndirectRef } from '../objects/types.ts'
import type { ObjectTable } from '../document/object_table.ts'
import { makeStream } from '../streams/stream.ts'
import { encodeWinAnsi } from './win_ansi.ts'
import {
  type StandardFontName,
  isStandardFontName,
  standardGlyphWidth,
  usesWinAnsi,
} from './standard_14.ts'
import { SfntFont } from './sfnt.ts'
import { parseCmap, type CmapLookup } from './cmap_table.ts'
import { Hmtx } from './hmtx.ts'
import { parseName } from './name_table.ts'
import { parseOs2, type Os2Metrics } from './os2.ts'
import { encodeIdentityH, buildWidthsArray } from './cid_encoding.ts'
import { buildToUnicode } from './to_unicode.ts'

export type { StandardFontName }

export interface TrueTypeOptions {
  /** Face to select from a `.ttc` collection (default 0). */
  faceIndex?: number
}

export abstract class PdfFont {
  abstract readonly id: string
  abstract readonly baseFont: string
  abstract readonly isStandard14: boolean

  /** Encode a string into the bytes that go inside a `Tj`/`TJ` string. */
  abstract encode(text: string): Uint8Array

  /** Rendered width of `text` in points at `sizePt`. */
  abstract widthOfText(text: string, sizePt: number): number

  /** Add the font's objects to the table; return the `/Font` reference. */
  abstract register(table: ObjectTable): IndirectRef

  /** Reference one of the Standard-14 fonts (never embedded, spec §10.1). */
  static standard(fontName: StandardFontName): PdfFont {
    return new Standard14Font(fontName)
  }

  /** Embed a TrueType (`glyf`) font from its `.ttf`/`.ttc` bytes. */
  static fromTrueType(bytes: Uint8Array, opts: TrueTypeOptions = {}): PdfFont {
    return new EmbeddedTrueTypeFont(bytes, opts.faceIndex ?? 0)
  }
}

// ── Standard-14 (referenced, never embedded) ──────────────────────────────

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
    for (const byte of this.encode(text)) units += standardGlyphWidth(this.fontName, byte)
    return (units * sizePt) / 1000
  }

  register(table: ObjectTable): IndirectRef {
    const d = dict({
      Type: name('Font'),
      Subtype: name('Type1'),
      BaseFont: name(this.baseFont),
    })
    if (this.winAnsi) d.entries.set('Encoding', name('WinAnsiEncoding'))
    return table.add(d)
  }
}

// ── Embedded TrueType → Type0 / CIDFontType2 (Identity-H) ──────────────────

class EmbeddedTrueTypeFont extends PdfFont {
  readonly id: string
  readonly baseFont: string
  readonly isStandard14 = false

  private readonly sfnt: SfntFont
  private readonly cmap: CmapLookup
  private readonly hmtx: Hmtx
  private readonly os2: Os2Metrics | null
  private readonly italicAngle: number
  private readonly fixedPitch: boolean

  /** Glyphs referenced so far (drives `/W`); gid → code points for ToUnicode. */
  private readonly usedGids = new Set<number>()
  private readonly gidToCps = new Map<number, number[]>()

  private static counter = 0

  constructor(bytes: Uint8Array, faceIndex: number) {
    super()
    this.sfnt = new SfntFont(bytes, faceIndex)

    const cmap = this.sfnt.table('cmap')
    if (!cmap) throw new UnsupportedFontError("Font is missing the required 'cmap' table")
    this.cmap = parseCmap(cmap)

    const hmtx = this.sfnt.table('hmtx')
    if (!hmtx) throw new UnsupportedFontError("Font is missing the required 'hmtx' table")
    this.hmtx = new Hmtx(hmtx, this.sfnt.hhea.numberOfHMetrics, this.sfnt.numGlyphs)

    this.os2 = parseOs2(this.sfnt.table('OS/2'))

    const nameTable = this.sfnt.table('name')
    const names = nameTable ? parseName(nameTable) : { postScriptName: null, family: null }
    const ps = (names.postScriptName || names.family || 'EmbeddedFont').replace(/[\s()<>[\]{}/%]/g, '')
    this.baseFont = ps
    this.id = `ttf:${ps}:${(EmbeddedTrueTypeFont.counter++).toString()}`

    const post = this.sfnt.table('post')
    if (post && post.length >= 16) {
      // italicAngle: Fixed 16.16 at offset 4; isFixedPitch: uint32 at 12.
      const raw = (post[4]! << 24) | (post[5]! << 16) | (post[6]! << 8) | post[7]!
      this.italicAngle = raw / 65536
      this.fixedPitch =
        ((post[12]! << 24) | (post[13]! << 16) | (post[14]! << 8) | post[15]!) !== 0
    } else {
      this.italicAngle = 0
      this.fixedPitch = false
    }
  }

  private gid(cp: number): number {
    return this.cmap.gidFor(cp)
  }

  encode(text: string): Uint8Array {
    const gids: number[] = []
    for (const ch of text) {
      const cp = ch.codePointAt(0)!
      const g = this.gid(cp)
      gids.push(g)
      this.usedGids.add(g)
      if (g !== 0) {
        const existing = this.gidToCps.get(g)
        if (!existing) this.gidToCps.set(g, [cp])
      }
    }
    return encodeIdentityH(gids)
  }

  widthOfText(text: string, sizePt: number): number {
    const upm = this.sfnt.head.unitsPerEm
    let units1000 = 0
    for (const ch of text) {
      const g = this.gid(ch.codePointAt(0)!)
      units1000 += (this.hmtx.advance(g) * 1000) / upm
    }
    return (units1000 * sizePt) / 1000
  }

  private get isItalic(): boolean {
    return (
      (this.os2 != null && (this.os2.fsSelection & 0x01) !== 0) ||
      (this.sfnt.head.macStyle & 0x02) !== 0 ||
      this.italicAngle !== 0
    )
  }

  /** PDF FontDescriptor /Flags (spec Table 121). */
  private flags(): number {
    let f = 1 << 5 // Nonsymbolic
    if (this.fixedPitch) f |= 1 << 0 // FixedPitch
    const fam = this.os2 ? (this.os2.sFamilyClass >> 8) & 0xff : 0
    if (fam >= 1 && fam <= 7 && fam !== 8) f |= 1 << 1 // Serif
    if (this.isItalic) f |= 1 << 6 // Italic
    return f
  }

  register(table: ObjectTable): IndirectRef {
    const upm = this.sfnt.head.unitsPerEm
    const scale = 1000 / upm
    const s = (v: number) => Math.round(v * scale)

    // FontFile2: the whole font program, FlateDecoded, with /Length1.
    const program = this.sfnt.programBytes
    const fontFileRef = table.add(
      makeStream(program, { filter: 'FlateDecode', extra: { Length1: num(program.length) } })
    )

    const ascent = this.os2 && this.os2.typoAscender ? this.os2.typoAscender : this.sfnt.hhea.ascent
    const descent =
      this.os2 && this.os2.typoDescender ? this.os2.typoDescender : this.sfnt.hhea.descent
    const capHeight = this.os2 && this.os2.capHeight ? this.os2.capHeight : Math.round(ascent * 0.7)
    const stemV = this.os2 && this.os2.weightClass >= 600 ? 120 : 80

    const descriptorRef = table.add(
      dict({
        Type: name('FontDescriptor'),
        FontName: name(this.baseFont),
        Flags: num(this.flags()),
        FontBBox: arr(
          [this.sfnt.head.xMin, this.sfnt.head.yMin, this.sfnt.head.xMax, this.sfnt.head.yMax]
            .map(s)
            .map(num)
        ),
        ItalicAngle: num(this.italicAngle),
        Ascent: num(s(ascent)),
        Descent: num(s(descent)),
        CapHeight: num(s(capHeight)),
        StemV: num(stemV),
        FontFile2: fontFileRef,
      })
    )

    const usedGids = [...this.usedGids]
    const cidFontRef = table.add(
      dict({
        Type: name('Font'),
        Subtype: name('CIDFontType2'),
        BaseFont: name(this.baseFont),
        CIDSystemInfo: dict({
          Registry: { kind: 'str', value: ascii('Adobe'), encoding: 'literal' },
          Ordering: { kind: 'str', value: ascii('Identity'), encoding: 'literal' },
          Supplement: num(0),
        }),
        FontDescriptor: descriptorRef,
        CIDToGIDMap: name('Identity'),
        DW: num(Math.round(this.hmtx.advance(0) * scale) || 1000),
        W: buildWidthsArray(usedGids, g => this.hmtx.advance(g), upm),
      })
    )

    const toUnicodeRef = table.add(
      makeStream(ascii(buildToUnicode(this.gidToCps)), { filter: 'FlateDecode' })
    )

    return table.add(
      dict({
        Type: name('Font'),
        Subtype: name('Type0'),
        BaseFont: name(this.baseFont),
        Encoding: name('Identity-H'),
        DescendantFonts: arr([cidFontRef]),
        ToUnicode: toUnicodeRef,
      })
    )
  }
}
