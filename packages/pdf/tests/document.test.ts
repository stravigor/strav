import { describe, test, expect } from 'bun:test'
import { PdfDocument } from '../src/document/pdf_document.ts'
import { mm } from '../src/util/units.ts'
import { PdfGenError } from '../src/util/errors.ts'
import { expectValidPdf, deterministicOpts } from './helpers.ts'

const dec = (b: Uint8Array) => new TextDecoder('latin1').decode(b)

describe('empty single-page document (M1 acceptance)', () => {
  test('has header, xref, trailer and EOF', async () => {
    const doc = PdfDocument.create(deterministicOpts)
    doc.addPage({ size: { widthPt: mm(210), heightPt: mm(297) } })
    const bytes = await doc.save()
    const s = dec(bytes)

    expect(s.startsWith('%PDF-1.7\n')).toBe(true)
    expect(s).toContain('/Type /Catalog')
    expect(s).toContain('/Type /Pages')
    expect(s).toContain('/Type /Page')
    expect(s).toContain('\nxref\n')
    expect(s).toContain('trailer')
    expect(s).toContain('/Root')
    expect(s).toContain('/ID [<')
    expect(s.trimEnd().endsWith('%%EOF')).toBe(true)
  })

  test('xref offsets point at the right objects', async () => {
    const doc = PdfDocument.create(deterministicOpts)
    doc.addPage({ size: { widthPt: 200, heightPt: 200 } })
    const bytes = await doc.save()
    const s = dec(bytes)

    const xrefStart = s.indexOf('xref\n')
    const lines = s.slice(xrefStart).split('\n')
    expect(lines[0]).toBe('xref')
    const [start, count] = lines[1]!.split(' ').map(Number)
    expect(start).toBe(0)
    // object 1's offset (line index 3: header, "0 N", free entry, obj1)
    const entry1 = lines[3]!
    const offset1 = Number(entry1.slice(0, 10))
    expect(s.slice(offset1, offset1 + 6)).toBe('1 0 ob')
    expect(count).toBeGreaterThanOrEqual(4)
  })

  test('passes qpdf --check', async () => {
    const doc = PdfDocument.create(deterministicOpts)
    doc.addPage({ size: { widthPt: 595, heightPt: 842 } })
    await expectValidPdf(await doc.save())
  })

  test('save() with no pages throws', async () => {
    const doc = PdfDocument.create()
    await expect(doc.save()).rejects.toThrow(PdfGenError)
  })

  test('addPage after save throws', async () => {
    const doc = PdfDocument.create(deterministicOpts)
    doc.addPage({ size: { widthPt: 100, heightPt: 100 } })
    await doc.save()
    expect(() => doc.addPage({ size: { widthPt: 100, heightPt: 100 } })).toThrow(PdfGenError)
  })
})

describe('byte-determinism (§16.3, §18.4)', () => {
  test('same fixed inputs → byte-identical output', async () => {
    const build = async () => {
      const doc = PdfDocument.create({ ...deterministicOpts, info: { title: 'Det' } })
      const p = doc.addPage({ size: { widthPt: 300, heightPt: 400 } })
      p.content().rect(10, 10, 50, 50).fill()
      return doc.save()
    }
    const a = await build()
    const b = await build()
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0)
  })

  test('multi-page (>50) balances into a fan-out tree', async () => {
    const doc = PdfDocument.create(deterministicOpts)
    for (let i = 0; i < 60; i++) doc.addPage({ size: { widthPt: 100, heightPt: 100 } })
    const bytes = await doc.save()
    expect(dec(bytes).match(/\/Type \/Pages/g)!.length).toBeGreaterThan(1)
    await expectValidPdf(bytes)
  })
})
