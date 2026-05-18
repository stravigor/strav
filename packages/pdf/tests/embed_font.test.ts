import { describe, test, expect } from 'bun:test'
import { SfntFont } from '../src/fonts/sfnt.ts'
import { parseCmap } from '../src/fonts/cmap_table.ts'
import { Hmtx } from '../src/fonts/hmtx.ts'
import { parseName } from '../src/fonts/name_table.ts'
import { GlyfTable } from '../src/fonts/glyf.ts'
import { buildToUnicode } from '../src/fonts/to_unicode.ts'
import { encodeIdentityH, buildWidthsArray } from '../src/fonts/cid_encoding.ts'
import { PdfFont } from '../src/fonts/font.ts'
import { encodeObject } from '../src/objects/encode.ts'
import { PdfDocument } from '../src/document/pdf_document.ts'
import { UnsupportedFontError } from '../src/util/errors.ts'
import { expectValidPdf, deterministicOpts } from './helpers.ts'
import { makeTrueTypeFont } from './fixtures/make_ttf.ts'

const FONT = makeTrueTypeFont()
const dec = (b: Uint8Array) => new TextDecoder('latin1').decode(b)

describe('SFNT parsing (§10.2)', () => {
  test('reads head / hhea / maxp', () => {
    const f = new SfntFont(FONT)
    expect(f.numGlyphs).toBe(4)
    expect(f.head.unitsPerEm).toBe(1000)
    expect(f.head.indexToLocFormat).toBe(1)
    expect([f.head.xMin, f.head.yMin, f.head.xMax, f.head.yMax]).toEqual([100, 0, 700, 700])
    expect(f.hhea.numberOfHMetrics).toBe(4)
    expect(f.hhea.ascent).toBe(800)
  })

  test('name table → PostScript name', () => {
    const f = new SfntFont(FONT)
    expect(parseName(f.table('name')!).postScriptName).toBe('SynthSans')
  })

  test('cmap maps code points to glyph indices', () => {
    const c = parseCmap(new SfntFont(FONT).table('cmap')!)
    expect(c.gidFor(0x48)).toBe(1) // H
    expect(c.gidFor(0x69)).toBe(2) // i
    expect(c.gidFor(0x20)).toBe(3) // space
    expect(c.gidFor(0x41)).toBe(0) // A — unmapped → .notdef
  })

  test('hmtx advance widths', () => {
    const f = new SfntFont(FONT)
    const h = new Hmtx(f.table('hmtx')!, f.hhea.numberOfHMetrics, f.numGlyphs)
    expect(h.advance(1)).toBe(600)
    expect(h.advance(2)).toBe(300)
    expect(h.advance(3)).toBe(250)
  })

  test('loca / glyf bounds and simple-glyph closure', () => {
    const f = new SfntFont(FONT)
    const g = new GlyfTable(
      f.table('loca')!,
      f.table('glyf')!,
      f.numGlyphs,
      f.head.indexToLocFormat === 1
    )
    expect(g.glyphData(0).length).toBe(0) // .notdef empty
    expect(g.glyphData(1).length).toBeGreaterThan(0)
    expect(g.componentGids(1)).toEqual([]) // simple, not composite
  })
})

describe('CID encoding & ToUnicode (§10.5, §10.6)', () => {
  test('Identity-H encodes 2-byte big-endian GIDs', () => {
    expect([...encodeIdentityH([1, 2, 0xabcd])]).toEqual([0, 1, 0, 2, 0xab, 0xcd])
  })

  test('/W collapses consecutive CIDs into runs', () => {
    const w = buildWidthsArray([1, 2, 3, 7], g => g * 100, 1000)
    expect(dec(encodeObject(w))).toBe('[1 [100 200 300] 7 [700]]')
  })

  test('ToUnicode uses bfrange for consecutive runs, bfchar otherwise', () => {
    const cmap = buildToUnicode(
      new Map([
        [1, [0x48]],
        [2, [0x49]], // consecutive gid+cp → bfrange with gid 1
        [9, [0x20ac]], // isolated → bfchar
      ])
    )
    expect(cmap).toContain('beginbfrange')
    expect(cmap).toContain('<0001> <0002> <0048>')
    expect(cmap).toContain('beginbfchar')
    expect(cmap).toContain('<0009> <20AC>')
    expect(cmap).toContain('/CMapName /Adobe-Identity-UCS def')
  })
})

describe('TrueType embedding (§10.4, M5 acceptance)', () => {
  test('encode + width use the cmap and hmtx', () => {
    const font = PdfFont.fromTrueType(FONT)
    expect([...font.encode('Hi')]).toEqual([0, 1, 0, 2]) // H=gid1, i=gid2
    expect(font.isStandard14).toBe(false)
    expect(font.baseFont).toBe('SynthSans')
    // widths: H=600, i=300 (font units, upm 1000) → 900 at size 1000
    expect(font.widthOfText('Hi', 1000)).toBeCloseTo(900, 6)
  })

  test('emits Type0 / CIDFontType2 / FontFile2 / ToUnicode and renders', async () => {
    const doc = PdfDocument.create(deterministicOpts)
    const page = doc.addPage({ size: { widthPt: 300, heightPt: 200 } })
    const font = PdfFont.fromTrueType(FONT)
    page.content().text((t) => t.setFont(font, 32).moveTo(40, 120).show('Hi'))
    const bytes = await doc.save()
    const s = dec(bytes)

    expect(s).toContain('/Subtype /Type0')
    expect(s).toContain('/Encoding /Identity-H')
    expect(s).toContain('/Subtype /CIDFontType2')
    expect(s).toContain('/CIDToGIDMap /Identity')
    expect(s).toContain('/Ordering (Identity)')
    expect(s).toContain('/FontFile2')
    expect(s).toContain('/Length1')
    expect(s).toContain('/FontDescriptor')
    expect(s).toContain('/ToUnicode')
    expect(s).toContain('/W [1 ') // glyph 1 width entry present

    await expectValidPdf(bytes)
  })

  test('byte-deterministic with an embedded font', async () => {
    const build = async () => {
      const doc = PdfDocument.create(deterministicOpts)
      const p = doc.addPage({ size: { widthPt: 200, heightPt: 200 } })
      p.content().text((t) =>
        t.setFont(PdfFont.fromTrueType(FONT), 20).moveTo(10, 150).show('Hii')
      )
      return doc.save()
    }
    expect(Buffer.compare(Buffer.from(await build()), Buffer.from(await build()))).toBe(0)
  })

  test('OpenType/CFF (OTTO) is rejected with a typed error', () => {
    const otto = new Uint8Array(64)
    otto.set([0x4f, 0x54, 0x54, 0x4f]) // 'OTTO'
    expect(() => PdfFont.fromTrueType(otto)).toThrow(UnsupportedFontError)
  })

  test('embedded fonts are allowed under conformance (unlike Standard-14)', async () => {
    const doc = PdfDocument.create({ ...deterministicOpts, conformance: 'PDF/A-2b' })
    const p = doc.addPage({ size: { widthPt: 200, heightPt: 200 } })
    p.content().text((t) => t.setFont(PdfFont.fromTrueType(FONT), 12).moveTo(10, 100).show('Hi'))
    await expect(doc.save()).resolves.toBeInstanceOf(Uint8Array)
  })
})
