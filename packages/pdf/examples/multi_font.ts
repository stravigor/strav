/**
 * Example: a multi-font document — the Standard-14 families, sizes, kerning,
 * and per-line color, plus measured text.
 *
 *   bun packages/pdf/examples/multi_font.ts
 *   → writes multi_font.pdf in the current directory
 */

import { PdfDocument, PdfFont, rgb, gray, mm } from '@strav/pdf'

const doc = PdfDocument.create({ info: { title: 'Multi-font', author: 'Strav' } })
const page = doc.addPage({ size: { widthPt: mm(210), heightPt: mm(297) } })
const c = page.content()

const families = [
  'Helvetica',
  'Helvetica-Bold',
  'Times-Roman',
  'Times-Italic',
  'Courier',
] as const

c.save().setFillColor(gray(0.1))
let y = mm(270)
for (const f of families) {
  c.text((t) =>
    t.setFont(PdfFont.standard(f), 20).moveTo(mm(20), y).show(`${f} — the quick brown fox`),
  )
  y -= mm(16)
}
c.restore()

// Kerning: plain vs. showRun with explicit adjustments.
c.save()
  .setFillColor(rgb(0.1, 0.1, 0.45))
  .text((t) => t.setFont(PdfFont.standard('Helvetica'), 30).moveTo(mm(20), mm(170)).show('AVA Wa Te'))
  .text((t) =>
    t
      .setFont(PdfFont.standard('Helvetica'), 30)
      .moveTo(mm(20), mm(158))
      .showRun([
        { text: 'A' },
        { adjust: -160 },
        { text: 'V' },
        { adjust: -160 },
        { text: 'A' },
        { adjust: -300 },
        { text: 'Wa' },
        { adjust: -200 },
        { text: 'Te' },
      ]),
  )
  .restore()

// Measure text and underline it exactly.
{
  const font = PdfFont.standard('Times-BoldItalic')
  const label = 'Measured with the font metrics'
  const w = font.widthOfText(label, 22)
  c.save()
    .setFillColor(gray(0))
    .text((t) => t.setFont(font, 22).moveTo(mm(20), mm(130)).show(label))
    .setStrokeColor(rgb(0.5, 0.1, 0.1))
    .setLineWidth(1)
    .moveTo(mm(20), mm(127))
    .lineTo(mm(20) + w, mm(127))
    .stroke()
    .restore()
}

await Bun.write('multi_font.pdf', await doc.save())
console.log('wrote multi_font.pdf')
