import { describe, test, expect } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { SfntFont } from '../src/fonts/sfnt.ts'
import { parseCmap } from '../src/fonts/cmap_table.ts'
import { subsetTrueType } from '../src/fonts/subset.ts'
import { PdfFont } from '../src/fonts/font.ts'
import { PdfDocument } from '../src/document/pdf_document.ts'
import { expectValidPdf, deterministicOpts } from './helpers.ts'
import { makeTrueTypeFont } from './fixtures/make_ttf.ts'

const FONT = makeTrueTypeFont()
const dec = (b: Uint8Array) => new TextDecoder('latin1').decode(b)

// Optional real-font coverage (skipped in CI if the font isn't present).
const SYSTEM_FONT = [
  '/System/Library/Fonts/Supplemental/Verdana.ttf',
  '/System/Library/Fonts/Supplemental/Georgia.ttf',
].find(p => existsSync(p))

describe('TrueType subsetting (§10.3)', () => {
  test('keeps original indices, drops trailing unused glyphs', () => {
    // Use only gid 1 ('H'); .notdef (0) is always kept → numGlyphs = 2.
    const { bytes } = subsetTrueType(new SfntFont(FONT), [1])
    const sub = new SfntFont(bytes)
    expect(new SfntFont(FONT).numGlyphs).toBe(4)
    expect(sub.numGlyphs).toBe(2)
    expect(sub.head.indexToLocFormat).toBe(1) // forced long loca
    expect(sub.hhea.numberOfHMetrics).toBe(2)
    // Passed-through tables still parse.
    expect(parseCmap(sub.table('cmap')!).gidFor(0x48)).toBe(1)
  })

  test('subset is smaller than the source and grows with the glyph set', () => {
    const one = subsetTrueType(new SfntFont(FONT), [1]).bytes.length
    const two = subsetTrueType(new SfntFont(FONT), [1, 2]).bytes.length
    expect(one).toBeLessThan(FONT.length)
    expect(two).toBeGreaterThanOrEqual(one)
  })

  test('subset tag is 6 uppercase letters and deterministic by content', () => {
    const a = subsetTrueType(new SfntFont(FONT), [1, 2]).tag
    const b = subsetTrueType(new SfntFont(FONT), [2, 1]).tag // order-independent
    const c = subsetTrueType(new SfntFont(FONT), [1]).tag
    expect(a).toMatch(/^[A-Z]{6}$/)
    expect(a).toBe(b)
    expect(a).not.toBe(c) // different glyph set → different tag
  })
})

describe('embedded subsetting integration (M6 acceptance)', () => {
  test('default embed is subsetted: tagged BaseFont, valid, extractable', async () => {
    const doc = PdfDocument.create(deterministicOpts)
    const page = doc.addPage({ size: { widthPt: 300, heightPt: 200 } })
    page.content().text(t => t.setFont(PdfFont.fromTrueType(FONT), 28).moveTo(40, 120).show('Hi'))
    const bytes = await doc.save()
    const s = dec(bytes)

    expect(s).toMatch(/\/BaseFont \/[A-Z]{6}\+SynthSans/)
    expect(s).toMatch(/\/FontName \/[A-Z]{6}\+SynthSans/)
    expect(s).toContain('/Subtype /CIDFontType2')
    expect(s).toContain('/FontFile2')
    await expectValidPdf(bytes)
  })

  test('subset:false embeds the whole font with an untagged name', async () => {
    const doc = PdfDocument.create(deterministicOpts)
    const page = doc.addPage({ size: { widthPt: 200, heightPt: 200 } })
    page
      .content()
      .text(t =>
        t.setFont(PdfFont.fromTrueType(FONT, { subset: false }), 20).moveTo(10, 150).show('Hi')
      )
    const s = dec(await doc.save())
    expect(s).toContain('/BaseFont /SynthSans')
    expect(s).not.toMatch(/\/BaseFont \/[A-Z]{6}\+/)
  })

  test('byte-deterministic with a subsetted font', async () => {
    const build = async () => {
      const doc = PdfDocument.create(deterministicOpts)
      const p = doc.addPage({ size: { widthPt: 200, heightPt: 200 } })
      p.content().text(t => t.setFont(PdfFont.fromTrueType(FONT), 18).moveTo(10, 150).show('Hii'))
      return doc.save()
    }
    expect(Buffer.compare(Buffer.from(await build()), Buffer.from(await build()))).toBe(0)
  })
})

describe('real-font subsetting (skipped if no system font)', () => {
  test.skipIf(!SYSTEM_FONT)('a few glyphs from a large font subsets tiny', () => {
    const raw = new Uint8Array(readFileSync(SYSTEM_FONT!))
    const sfnt = new SfntFont(raw)
    const cmap = parseCmap(sfnt.table('cmap')!)
    const gids = [...'Hello, print world.'].map(ch => cmap.gidFor(ch.codePointAt(0)!))
    const { bytes, tag } = subsetTrueType(sfnt, gids)

    expect(tag).toMatch(/^[A-Z]{6}$/)
    // Glyph outlines collapse to the used set; non-glyf tables pass through
    // unchanged (spec §10.3), so the bound is the spec's 100 KB budget.
    expect(bytes.length).toBeLessThan(raw.length / 2)
    expect(bytes.length).toBeLessThan(100_000)
    // Re-parses and the kept glyphs are intact.
    const sub = new SfntFont(bytes)
    expect(sub.numGlyphs).toBeLessThan(sfnt.numGlyphs)
    expect(sub.numGlyphs).toBe(Math.max(...gids) + 1)
  })
})
