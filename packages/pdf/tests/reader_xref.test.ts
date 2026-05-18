import { describe, test, expect } from 'bun:test'
import { PdfDocument } from '../src/document/pdf_document.ts'
import { PdfFont } from '../src/fonts/font.ts'
import { extractText } from '../src/reader/extract.ts'
import { PdfReaderDocument } from '../src/reader/document.ts'
import { deterministicOpts } from './helpers.ts'

const enc = (s: string) => new TextEncoder().encode(s)

function cat(parts: (string | Uint8Array)[]): Uint8Array {
  const arrs = parts.map((p) => (typeof p === 'string' ? enc(p) : p))
  const len = arrs.reduce((a, p) => a + p.length, 0)
  const out = new Uint8Array(len)
  let o = 0
  for (const p of arrs) {
    out.set(p, o)
    o += p.length
  }
  return out
}

describe('classic xref (writer round-trip)', () => {
  test('parses the writer’s classic xref + trailer', async () => {
    const doc = PdfDocument.create(deterministicOpts)
    const p = doc.addPage({ size: { widthPt: 200, heightPt: 200 } })
    p.content().text((t) =>
      t.setFont(PdfFont.standard('Helvetica'), 12).moveTo(20, 150).show('classic'),
    )
    const bytes = await doc.save()
    const rd = new PdfReaderDocument(bytes)
    expect(rd.pages().length).toBe(1)
    expect((await extractText(bytes)).pages[0]!.text).toContain('classic')
  })

  test('brute-force recovery when startxref is corrupt', async () => {
    const doc = PdfDocument.create(deterministicOpts)
    const p = doc.addPage({ size: { widthPt: 200, heightPt: 200 } })
    p.content().text((t) =>
      t.setFont(PdfFont.standard('Helvetica'), 12).moveTo(20, 150).show('recovered'),
    )
    const bytes = await doc.save()
    // Corrupt the startxref offset → forces the brute-force object scan.
    const s = new TextDecoder('latin1').decode(bytes)
    const idx = s.lastIndexOf('startxref')
    const broken = bytes.slice()
    broken.set(enc('999999999'), idx + 'startxref\n'.length)
    const r = await extractText(broken)
    expect(r.pages[0]!.text).toContain('recovered')
  })
})

describe('xref stream + object stream (PDF 1.5)', () => {
  test('resolves compressed objects via /XRef + /ObjStm', async () => {
    // Objects 1 (Catalog), 2 (Pages), 5 (Font) live in ObjStm #6.
    // Objects 3 (Page), 4 (Contents), 6 (ObjStm), 7 (XRef) are regular.
    const o1 = '<</Type/Catalog/Pages 2 0 R>>'
    const o2 = '<</Type/Pages/Kids[3 0 R]/Count 1>>'
    const o5 = '<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>'

    // ObjStm payload: "N off" pairs then the objects.
    const offsets = [0, o1.length + 1, o1.length + 1 + o2.length + 1]
    const header = `1 ${offsets[0]} 2 ${offsets[1]} 5 ${offsets[2]} `
    const objStmBody = `${o1} ${o2} ${o5} `
    const objStmData = header + objStmBody

    const content = 'BT /F1 12 Tf 20 150 Td (xref stream ok) Tj ET'

    const offset = new Map<number, number>()
    const chunks: (string | Uint8Array)[] = ['%PDF-1.5\n']
    let len = chunks[0]!.length

    const emit = (n: number, s: string) => {
      offset.set(n, len)
      chunks.push(s)
      len += s.length
    }
    emit(3, `3 0 obj\n<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>\nendobj\n`)
    emit(4, `4 0 obj\n<</Length ${content.length}>>\nstream\n${content}\nendstream\nendobj\n`)
    emit(6, `6 0 obj\n<</Type/ObjStm/N 3/First ${header.length}/Length ${objStmData.length}>>\nstream\n${objStmData}\nendstream\nendobj\n`)

    // XRef stream (obj 7). /W [1 4 2]; Index default [0 8].
    const xrefOffset = len
    offset.set(7, xrefOffset)
    const entries: [number, number, number][] = [
      [0, 0, 65535], // 0: free
      [2, 6, 0], // 1 → objstm 6, idx 0
      [2, 6, 1], // 2 → objstm 6, idx 1
      [1, offset.get(3)!, 0], // 3
      [1, offset.get(4)!, 0], // 4
      [2, 6, 2], // 5 → objstm 6, idx 2
      [1, offset.get(6)!, 0], // 6
      [1, xrefOffset, 0], // 7
    ]
    const data = new Uint8Array(entries.length * 7)
    entries.forEach(([t, f2, f3], i) => {
      const b = i * 7
      data[b] = t
      data[b + 1] = (f2 >>> 24) & 0xff
      data[b + 2] = (f2 >>> 16) & 0xff
      data[b + 3] = (f2 >>> 8) & 0xff
      data[b + 4] = f2 & 0xff
      data[b + 5] = (f3 >>> 8) & 0xff
      data[b + 6] = f3 & 0xff
    })
    const xrefDict = `7 0 obj\n<</Type/XRef/Size 8/W[1 4 2]/Root 1 0 R/Length ${data.length}>>\nstream\n`
    const pdf = cat([
      ...chunks,
      xrefDict,
      data,
      `\nendstream\nendobj\nstartxref\n${xrefOffset}\n%%EOF`,
    ])

    const r = await extractText(pdf)
    expect(r.info.pageCount).toBe(1)
    expect(r.pages[0]!.text).toContain('xref stream ok')
  })
})
