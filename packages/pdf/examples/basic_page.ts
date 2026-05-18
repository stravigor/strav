/**
 * Example: a basic page — vector graphics + Standard-14 text.
 *
 *   bun packages/pdf/examples/basic_page.ts
 *   → writes basic_page.pdf in the current directory
 */

import { PdfDocument, PdfFont, rgb, gray, mm } from '@strav/pdf'

const doc = PdfDocument.create({ info: { title: 'Basic Page', author: 'Strav' } })

const page = doc.addPage({ size: { widthPt: mm(210), heightPt: mm(297) } })

page
  .content()
  .save()
  .setFillColor(rgb(0.95, 0.55, 0.1))
  .rect(mm(20), mm(240), mm(80), mm(40))
  .fill()
  .setStrokeColor(gray(0))
  .setLineWidth(1.5)
  .moveTo(mm(20), mm(232))
  .lineTo(mm(190), mm(232))
  .stroke()
  .moveTo(mm(20), mm(180))
  .curveTo(mm(60), mm(220), mm(140), mm(140), mm(190), mm(180))
  .stroke()
  .text((t) =>
    t
      .setFont(PdfFont.standard('Helvetica-Bold'), 28)
      .moveTo(mm(20), mm(255))
      .show('Hello, @strav/pdf'),
  )
  .restore()

await Bun.write('basic_page.pdf', await doc.save())
console.log('wrote basic_page.pdf')
