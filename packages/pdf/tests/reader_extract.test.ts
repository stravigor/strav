import { describe, test, expect } from 'bun:test'
import { PdfDocument } from '../src/document/pdf_document.ts'
import { PdfFont } from '../src/fonts/font.ts'
import { extractText, PdfReader } from '../src/reader/extract.ts'
import { deterministicOpts } from './helpers.ts'
import { makeTrueTypeFont } from './fixtures/make_ttf.ts'

async function helveticaPdf(
  build: (t: import('../src/content/text_object.ts').TextObject) => void,
  opts: Record<string, unknown> = {},
): Promise<Uint8Array> {
  const doc = PdfDocument.create({ ...deterministicOpts, ...opts })
  const page = doc.addPage({ size: { widthPt: 400, heightPt: 400 } })
  page.content().text((t) => {
    t.setFont(PdfFont.standard('Helvetica'), 12)
    build(t)
  })
  return doc.save()
}

describe('extractText — Standard-14 (WinAnsi)', () => {
  test('extracts a single line of text', async () => {
    const bytes = await helveticaPdf((t) => t.moveTo(50, 300).show('Hello World'))
    const r = await extractText(bytes)
    expect(r.pages).toHaveLength(1)
    expect(r.pages[0]!.text).toContain('Hello World')
    expect(r.info.pageCount).toBe(1)
    expect(r.info.encrypted).toBe(false)
  })

  test('WinAnsi punctuation round-trips', async () => {
    const bytes = await helveticaPdf((t) =>
      t.moveTo(20, 300).show('“quotes” — café €'),
    )
    const r = await extractText(bytes)
    expect(r.pages[0]!.text).toContain('“quotes”')
    expect(r.pages[0]!.text).toContain('café')
    expect(r.pages[0]!.text).toContain('€')
  })

  test('Td / T* produce line breaks', async () => {
    const bytes = await helveticaPdf((t) => {
      t.setLeading(16).moveTo(20, 300).show('line one')
      t.newLine().show('line two')
    })
    const r = await extractText(bytes)
    const lines = r.pages[0]!.text.split('\n').filter((l) => l.trim())
    expect(lines[0]).toContain('line one')
    expect(lines[1]).toContain('line two')
  })

  test('TJ kerning gaps become a word space', async () => {
    const bytes = await helveticaPdf((t) =>
      t.moveTo(20, 300).showRun([{ text: 'foo' }, { adjust: -400 }, { text: 'bar' }]),
    )
    const r = await extractText(bytes)
    expect(r.pages[0]!.text.replace(/\s+/g, ' ')).toContain('foo bar')
  })

  test('normalizeWhitespace=false keeps raw spacing', async () => {
    const bytes = await helveticaPdf((t) => t.moveTo(20, 300).show('a   b'))
    const norm = await extractText(bytes, { normalizeWhitespace: true })
    const raw = await extractText(bytes, { normalizeWhitespace: false })
    expect(norm.pages[0]!.text).not.toMatch(/ {2,}/)
    expect(raw.pages[0]!.text.length).toBeGreaterThanOrEqual(norm.pages[0]!.text.length)
  })
})

describe('extractText — documents', () => {
  test('multi-page with page selection and \\f separator', async () => {
    const doc = PdfDocument.create(deterministicOpts)
    for (const label of ['PageOne', 'PageTwo', 'PageThree']) {
      const p = doc.addPage({ size: { widthPt: 300, heightPt: 300 } })
      p.content().text((t) => t.setFont(PdfFont.standard('Helvetica'), 14).moveTo(20, 200).show(label))
    }
    const bytes = await doc.save()

    const all = await extractText(bytes)
    expect(all.pages.map((p) => p.number)).toEqual([1, 2, 3])
    expect(all.text.split('\f')).toHaveLength(3)
    expect(all.pages[1]!.text).toContain('PageTwo')

    const sub = await extractText(bytes, { pages: { from: 2, to: 3 } })
    expect(sub.pages.map((p) => p.number)).toEqual([2, 3])
    expect(sub.pages[0]!.text).toContain('PageTwo')

    const one = await extractText(bytes, { pages: 1 })
    expect(one.pages).toHaveLength(1)
    expect(one.pages[0]!.text).toContain('PageOne')
  })

  test('reads /Info metadata', async () => {
    const bytes = await helveticaPdf((t) => t.moveTo(20, 200).show('x'), {
      info: { title: 'My Title', author: 'Ada' },
    })
    const reader = await PdfReader.open(bytes)
    expect(reader.info.title).toBe('My Title')
    expect(reader.info.author).toBe('Ada')
    expect(reader.pageCount).toBe(1)
  })
})

describe('extractText — embedded TrueType (Type0 + ToUnicode)', () => {
  test('decodes Identity-H text via the ToUnicode CMap', async () => {
    const doc = PdfDocument.create(deterministicOpts)
    const p = doc.addPage({ size: { widthPt: 200, heightPt: 200 } })
    p.content().text((t) =>
      t.setFont(PdfFont.fromTrueType(makeTrueTypeFont()), 20).moveTo(10, 150).show('Hi'),
    )
    const bytes = await doc.save()
    const r = await extractText(bytes)
    expect(r.pages[0]!.text).toContain('Hi')
  })
})
