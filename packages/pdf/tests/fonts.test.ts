import { describe, test, expect } from 'bun:test'
import { PdfFont } from '../src/fonts/font.ts'
import { encodeWinAnsi } from '../src/fonts/win_ansi.ts'
import { ContentStream } from '../src/content/content_stream.ts'
import { PdfDocument } from '../src/document/pdf_document.ts'
import { PdfGenError, UnsupportedFontError } from '../src/util/errors.ts'
import { expectValidPdf, deterministicOpts } from './helpers.ts'

const dec = (cs: ContentStream) => new TextDecoder('latin1').decode(cs.toBytes())

describe('Standard-14 width math (§10, AFM)', () => {
  test('canonical AFM widths', () => {
    const helv = PdfFont.standard('Helvetica')
    // Helvetica: space=278, 'A'=667, scaled by size/1000.
    expect(helv.widthOfText(' ', 1000)).toBeCloseTo(278, 6)
    expect(helv.widthOfText('A', 1000)).toBeCloseTo(667, 6)
    expect(helv.widthOfText('AV', 12)).toBeCloseTo(((667 + 667) * 12) / 1000, 6)

    const times = PdfFont.standard('Times-Roman')
    expect(times.widthOfText('A', 1000)).toBeCloseTo(722, 6)
    expect(times.widthOfText(' ', 1000)).toBeCloseTo(250, 6)

    // Courier is monospaced: every glyph 600.
    const cour = PdfFont.standard('Courier')
    expect(cour.widthOfText('iW.', 1000)).toBeCloseTo(1800, 6)
  })

  test('Helvetica and Helvetica-Oblique share metrics', () => {
    const a = PdfFont.standard('Helvetica').widthOfText('Hello, world.', 12)
    const b = PdfFont.standard('Helvetica-Oblique').widthOfText('Hello, world.', 12)
    expect(a).toBeCloseTo(b, 9)
  })
})

describe('WinAnsi encoding (§10.4)', () => {
  test('ASCII is identity; CP1252 high band maps; astral throws', () => {
    expect([...encodeWinAnsi('AB')]).toEqual([0x41, 0x42])
    expect([...encodeWinAnsi('€')]).toEqual([0x80]) // €
    expect([...encodeWinAnsi('’')]).toEqual([0x92]) // ’
    expect([...encodeWinAnsi('é')]).toEqual([0xe9]) // é (Latin-1)
    expect(() => encodeWinAnsi('世')).toThrow(PdfGenError)
  })
})

describe('text object operator bytes (§10.7, M4 acceptance)', () => {
  test('BT/Tf/Td/Tj/ET with a Standard-14 font', () => {
    const helv = PdfFont.standard('Helvetica')
    const cs = new ContentStream()
    cs.text(t => t.setFont(helv, 12).moveTo(72, 720).show('Hello world'))
    expect(dec(cs)).toBe(
      ['BT', '/F1 12 Tf', '1 0 0 1 72 720 Tm', '(Hello world) Tj', 'ET', ''].join('\n')
    )
  })

  test('showRun emits a TJ array with kerning adjustments', () => {
    const cs = new ContentStream()
    cs.text(t =>
      t
        .setFont(PdfFont.standard('Helvetica'), 10)
        .showRun([{ text: 'Wa' }, { adjust: -120 }, { text: 'ter' }])
    )
    expect(dec(cs)).toContain('[(Wa) -120 (ter)] TJ')
  })

  test('parens in shown text are escaped', () => {
    const cs = new ContentStream()
    cs.text(t => t.setFont(PdfFont.standard('Helvetica'), 12).show('a(b)c'))
    expect(dec(cs)).toContain('(a\\(b\\)c) Tj')
  })

  test('font resource names are stable and deduped', () => {
    const h = PdfFont.standard('Helvetica')
    const cs = new ContentStream()
    cs.text(t => {
      t.setFont(h, 12).show('x')
      t.setFont(PdfFont.standard('Times-Roman'), 12).show('y')
      t.setFont(h, 8).show('z')
    })
    const s = dec(cs)
    expect(s).toContain('/F1 12 Tf')
    expect(s).toContain('/F2 12 Tf')
    expect(s).toContain('/F1 8 Tf') // reused, not F3
    expect(cs.usedFonts()).toHaveLength(2)
  })
})

describe('text state guards', () => {
  test('show before setFont throws', () => {
    const cs = new ContentStream()
    expect(() => cs.text(t => t.show('x'))).toThrow(/setFont/)
  })

  test('a throwing callback still closes the block (BT…ET balanced)', () => {
    const cs = new ContentStream()
    expect(() =>
      cs.text(() => {
        throw new Error('boom')
      })
    ).toThrow('boom')
    // finally emits ET and resets inText, so the stream stays balanced.
    expect(() => cs.assertBalanced()).not.toThrow()
    expect(dec(cs)).toBe('BT\nET\n')
  })

  test('path/graphics operators inside text() throw', () => {
    const cs = new ContentStream()
    expect(() =>
      cs.text(() => {
        cs.rect(0, 0, 1, 1)
      })
    ).toThrow(/not allowed inside a text/)
    const cs2 = new ContentStream()
    expect(() =>
      cs2.text(() => {
        cs2.save()
      })
    ).toThrow(PdfGenError)
  })

  test('text() with an open path throws', () => {
    const cs = new ContentStream()
    cs.moveTo(0, 0).lineTo(1, 1)
    expect(() => cs.text(t => t.setFont(PdfFont.standard('Courier'), 10))).toThrow(
      /Unconsumed path/
    )
  })
})

describe('document integration (M4 acceptance)', () => {
  test('renders text in Helvetica/Times/Courier and is a valid PDF', async () => {
    const doc = PdfDocument.create(deterministicOpts)
    const page = doc.addPage({ size: { widthPt: 400, heightPt: 300 } })
    page.content().text(t => {
      t.setFont(PdfFont.standard('Helvetica'), 24).moveTo(40, 240).show('Hello world')
      t.setFont(PdfFont.standard('Times-Roman'), 18).moveTo(40, 200).show('Times here')
      t.setFont(PdfFont.standard('Courier'), 14).moveTo(40, 170).show('mono 12345')
    })
    const bytes = await doc.save()
    const s = new TextDecoder('latin1').decode(bytes)
    expect(s).toContain('/Type /Font')
    expect(s).toContain('/BaseFont /Helvetica')
    expect(s).toContain('/Encoding /WinAnsiEncoding')
    expect(s).toContain('/Resources <</Font <<')
    await expectValidPdf(bytes)
  })

  test('byte-deterministic with text', async () => {
    const build = async () => {
      const doc = PdfDocument.create(deterministicOpts)
      const p = doc.addPage({ size: { widthPt: 200, heightPt: 200 } })
      p.content().text(t => t.setFont(PdfFont.standard('Helvetica'), 12).moveTo(10, 180).show('Hi'))
      return doc.save()
    }
    expect(Buffer.compare(Buffer.from(await build()), Buffer.from(await build()))).toBe(0)
  })

  test('Standard-14 under a conformance mode is rejected (§10.1, §23)', async () => {
    const doc = PdfDocument.create({ ...deterministicOpts, conformance: 'PDF/A-2b' })
    const p = doc.addPage({ size: { widthPt: 200, heightPt: 200 } })
    p.content().text(t => t.setFont(PdfFont.standard('Helvetica'), 12).moveTo(10, 10).show('x'))
    await expect(doc.save()).rejects.toThrow(UnsupportedFontError)
  })
})
