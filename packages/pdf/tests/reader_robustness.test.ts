import { describe, test, expect } from 'bun:test'
import { PdfDocument } from '../src/document/pdf_document.ts'
import { extractText } from '../src/reader/extract.ts'
import { buildClassicPdf } from './fixtures/classic_pdf.ts'

const F1 = '<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>'
const page = (contents: number) =>
  `<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents ${contents} 0 R/Resources<</Font<</F1 5 0 R>>>>>>`

describe('robustness', () => {
  test('inline image (BI/ID/EI) is skipped without misparsing binary', async () => {
    // Binary payload deliberately contains bytes that look like operators
    // and an "EI" that is NOT whitespace-delimited.
    const bin = 'Tj()<<EIxx\x00\x01\x02'
    const content =
      `q 10 0 0 10 0 0 cm BI /W 2 /H 2 /BPC 8 /CS /G ID ${bin} EI Q\n` +
      `BT /F1 12 Tf 20 150 Td (after image) Tj ET`
    const pdf = buildClassicPdf(
      [
        { num: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
        { num: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
        { num: 3, body: page(4) },
        { num: 4, body: `<</Length ${content.length}>>\nstream\n${content}\nendstream` },
        { num: 5, body: F1 },
      ],
      { Root: '1 0 R' },
    )
    const r = await extractText(pdf)
    expect(r.pages[0]!.text).toContain('after image')
    expect(r.pages[0]!.text).not.toContain('EIxx')
  })

  test('cyclic page tree terminates', async () => {
    const pdf = buildClassicPdf(
      [
        { num: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
        { num: 2, body: '<</Type/Pages/Kids[2 0 R]/Count 1>>' }, // self-reference
      ],
      { Root: '1 0 R' },
    )
    const r = await extractText(pdf)
    expect(r.info.pageCount).toBe(0)
  })

  test('Type0 font without ToUnicode → no throw, replacement chars', async () => {
    const content = 'BT /F1 12 Tf 20 150 Td <00480049> Tj ET'
    const pdf = buildClassicPdf(
      [
        { num: 1, body: '<</Type/Catalog/Pages 2 0 R>>' },
        { num: 2, body: '<</Type/Pages/Kids[3 0 R]/Count 1>>' },
        { num: 3, body: page(4) },
        { num: 4, body: `<</Length ${content.length}>>\nstream\n${content}\nendstream` },
        {
          num: 5,
          body:
            '<</Type/Font/Subtype/Type0/BaseFont/X/Encoding/Identity-H' +
            '/DescendantFonts[<</Type/Font/Subtype/CIDFontType2/BaseFont/X' +
            '/CIDSystemInfo<</Registry(Adobe)/Ordering(Identity)/Supplement 0>>/DW 600>>]>>',
        },
      ],
      { Root: '1 0 R' },
    )
    const r = await extractText(pdf)
    expect(r.info.pageCount).toBe(1)
    expect(typeof r.pages[0]!.text).toBe('string') // did not throw
  })

  test('page with no content stream yields empty text', async () => {
    const doc = PdfDocument.create()
    doc.addPage({ size: { widthPt: 100, heightPt: 100 } })
    const bytes = await doc.save()
    const r = await extractText(bytes)
    expect(r.pages).toHaveLength(1)
    expect(r.pages[0]!.text).toBe('')
  })
})
