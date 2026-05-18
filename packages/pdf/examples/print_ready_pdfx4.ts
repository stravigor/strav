/**
 * Example: a print-ready PDF/X-4 document, written via streaming output.
 *
 * PDF/X-4 requires an embedded font and a CMYK/Gray output-intent profile, so
 * you supply your own:
 *
 *   bun packages/pdf/examples/print_ready_pdfx4.ts <font.ttf> <cmyk.icc>
 *   → streams print_ready.pdf to the current directory
 *
 * With no arguments it prints usage and exits (nothing to embed).
 */

import { createWriteStream } from 'node:fs'
import { readFileSync } from 'node:fs'
import { PdfDocument, PdfFont, rgb, gray, mm } from '@strav/pdf'

const [fontPath, iccPath] = process.argv.slice(2)
if (!fontPath || !iccPath) {
  console.log('usage: bun print_ready_pdfx4.ts <font.ttf|.otf> <cmyk-or-gray.icc>')
  console.log('  PDF/X-4 needs an embedded font and a CMYK/Gray ICC profile.')
  process.exit(0)
}

const doc = PdfDocument.create({
  info: { title: 'Print-Ready', author: 'Strav', subject: 'PDF/X-4 sample' },
})
doc.setConformance('PDF/X-4')
doc.setOutputIntent({
  subtype: 'GTS_PDFX',
  outputConditionIdentifier: 'FOGRA39',
  registryName: 'http://www.color.org',
  destOutputProfile: new Uint8Array(readFileSync(iccPath)),
})

const font = PdfFont.fromTrueType(new Uint8Array(readFileSync(fontPath))) // embedded, subsetted

const W = mm(210)
const H = mm(297)
const page = doc.addPage({ size: { widthPt: W, heightPt: H } })
page.setMediaBox({ x: 0, y: 0, w: W, h: H })
page.setBleedBox({ x: mm(5), y: mm(5), w: W - mm(10), h: H - mm(10) })
page.setTrimBox({ x: mm(12), y: mm(12), w: W - mm(24), h: H - mm(24) })

page
  .content()
  .save()
  .setFillColor(rgb(0.1, 0.2, 0.5))
  .rect(mm(12), H - mm(50), W - mm(24), mm(38))
  .fill()
  .setFillColor(gray(1))
  .text((t) => t.setFont(font, 26).moveTo(mm(20), H - mm(38)).show('Print-Ready PDF/X-4'))
  .restore()

// Stream to the file — no full-document buffer (spec §3.3).
await doc.saveToStream(createWriteStream('print_ready.pdf'))
console.log('streamed print_ready.pdf (PDF/X-4)')
