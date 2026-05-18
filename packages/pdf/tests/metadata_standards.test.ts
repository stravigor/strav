import { describe, test, expect } from 'bun:test'
import { buildXmpPacket } from '../src/metadata/xmp.ts'
import { PdfDocument } from '../src/document/pdf_document.ts'
import { PdfFont } from '../src/fonts/font.ts'
import { ConformanceError, UnsupportedFontError, PdfGenError } from '../src/util/errors.ts'
import { expectValidPdf, deterministicOpts } from './helpers.ts'
import { makeTrueTypeFont } from './fixtures/make_ttf.ts'

const dec = (b: Uint8Array) => new TextDecoder('latin1').decode(b)
const TTF = makeTrueTypeFont()

/** Minimal valid 128-byte ICC header for the given data color space. */
function makeIcc(sig: 'GRAY' | 'RGB ' | 'CMYK'): Uint8Array {
  const b = new Uint8Array(132)
  const put = (s: string, o: number) => {
    for (let i = 0; i < 4; i++) b[o + i] = s.charCodeAt(i)
  }
  put('prtr', 12)
  put(sig, 16)
  put('Lab ', 20)
  put('acsp', 36)
  return b
}

describe('XMP packet (§14.2)', () => {
  const base = { creationDate: new Date(Date.UTC(2026, 4, 18, 9, 30)), producer: '@strav/pdf' }

  test('core dc/xmp/pdf properties + xpacket wrapper', () => {
    const x = buildXmpPacket({
      ...base,
      info: { title: 'A & B <ok>', author: 'Ada', subject: 'Sub', keywords: 'x, y' },
      conformance: null,
    })
    expect(x).toContain('<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>')
    expect(x).toContain('<dc:title><rdf:Alt><rdf:li xml:lang="x-default">A &amp; B &lt;ok&gt;')
    expect(x).toContain('<dc:creator><rdf:Seq><rdf:li>Ada</rdf:li>')
    expect(x).toContain('<xmp:CreateDate>2026-05-18T09:30:00+00:00</xmp:CreateDate>')
    expect(x).toContain('<pdf:Producer>@strav/pdf</pdf:Producer>')
    expect(x).toContain('<dc:subject><rdf:Bag><rdf:li>x</rdf:li><rdf:li>y</rdf:li></rdf:Bag>')
    expect(x).toContain('<?xpacket end="w"?>')
    expect(x).not.toContain('pdfaid')
    expect(x).not.toContain('pdfxid')
  })

  test('PDF/A-2b adds pdfaid; PDF/X-4 adds pdfxid', () => {
    const a = buildXmpPacket({ ...base, info: {}, conformance: 'PDF/A-2b' })
    expect(a).toContain('xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"')
    expect(a).toContain('<pdfaid:part>2</pdfaid:part>')
    expect(a).toContain('<pdfaid:conformance>B</pdfaid:conformance>')
    const x = buildXmpPacket({ ...base, info: {}, conformance: 'PDF/X-4' })
    expect(x).toContain('<pdfxid:GTS_PDFXVersion>PDF/X-4</pdfxid:GTS_PDFXVersion>')
  })
})

describe('document metadata', () => {
  test('every PDF carries an uncompressed /Metadata XMP stream + Info', async () => {
    const doc = PdfDocument.create({ ...deterministicOpts, info: { title: 'Doc', author: 'Me' } })
    doc.addPage({ size: { widthPt: 100, heightPt: 100 } })
    const s = dec(await doc.save())
    expect(s).toContain('/Type /Catalog')
    expect(s).toMatch(/\/Metadata \d+ 0 R/)
    expect(s).toContain('/Type /Metadata /Subtype /XML')
    expect(s).toContain('<?xpacket begin=')
    expect(s).not.toMatch(/\/Type \/Metadata[^>]*\/Filter/) // uncompressed
    expect(s).toContain('/Producer') // Info dict still present
  })
})

describe('conformance validation (§15)', () => {
  test('PDF/X-4 without an output intent is rejected', async () => {
    const doc = PdfDocument.create(deterministicOpts).setConformance('PDF/X-4')
    const p = doc.addPage({ size: { widthPt: 200, heightPt: 200 } })
    p.setTrimBox({ x: 0, y: 0, w: 200, h: 200 })
    await expect(doc.save()).rejects.toThrow(ConformanceError)
  })

  test('PDF/X-4 lists every missing TrimBox/ArtBox', async () => {
    const doc = PdfDocument.create(deterministicOpts).setConformance('PDF/X-4')
    doc.setOutputIntent({
      subtype: 'GTS_PDFX',
      outputConditionIdentifier: 'FOGRA39',
      destOutputProfile: makeIcc('CMYK'),
    })
    doc.addPage({ size: { widthPt: 200, heightPt: 200 } }) // no trim/art
    try {
      await doc.save()
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(ConformanceError)
      expect((e as ConformanceError).violations.join()).toContain('TrimBox or ArtBox')
    }
  })

  test('PDF/X-4 rejects an RGB output-intent profile', async () => {
    const doc = PdfDocument.create(deterministicOpts).setConformance('PDF/X-4')
    doc.setOutputIntent({
      subtype: 'GTS_PDFX',
      outputConditionIdentifier: 'sRGB',
      destOutputProfile: makeIcc('RGB '),
    })
    const p = doc.addPage({ size: { widthPt: 100, heightPt: 100 } })
    p.setTrimBox({ x: 0, y: 0, w: 100, h: 100 })
    await expect(doc.save()).rejects.toThrow(/CMYK or Gray/)
  })

  test('a conforming PDF/X-4 document saves and claims it in XMP', async () => {
    const doc = PdfDocument.create(deterministicOpts).setConformance('PDF/X-4')
    doc.setOutputIntent({
      subtype: 'GTS_PDFX',
      outputConditionIdentifier: 'FOGRA39',
      destOutputProfile: makeIcc('CMYK'),
    })
    const p = doc.addPage({ size: { widthPt: 200, heightPt: 280 } })
    p.setTrimBox({ x: 0, y: 0, w: 200, h: 280 })
    p.content().text(t => t.setFont(PdfFont.fromTrueType(TTF), 12).moveTo(20, 200).show('Hi'))
    const bytes = await doc.save()
    expect(dec(bytes)).toContain('<pdfxid:GTS_PDFXVersion>PDF/X-4')
    await expectValidPdf(bytes)
  })

  test('PDF/A-2b requires an output intent, then conforms', async () => {
    const bad = PdfDocument.create(deterministicOpts).setConformance('PDF/A-2b')
    bad.addPage({ size: { widthPt: 100, heightPt: 100 } })
    await expect(bad.save()).rejects.toThrow(ConformanceError)

    const ok = PdfDocument.create(deterministicOpts).setConformance('PDF/A-2b')
    ok.setOutputIntent({
      subtype: 'GTS_PDFA1',
      outputConditionIdentifier: 'sGray',
      destOutputProfile: makeIcc('GRAY'),
    })
    const p = ok.addPage({ size: { widthPt: 100, heightPt: 100 } })
    p.content().text(t => t.setFont(PdfFont.fromTrueType(TTF), 12).moveTo(10, 80).show('Hi'))
    expect(dec(await ok.save())).toContain('<pdfaid:part>2</pdfaid:part>')
  })

  test('Standard-14 under conformance throws UnsupportedFontError (fail-fast)', async () => {
    const doc = PdfDocument.create(deterministicOpts).setConformance('PDF/A-2b')
    doc.setOutputIntent({
      subtype: 'GTS_PDFA1',
      outputConditionIdentifier: 'g',
      destOutputProfile: makeIcc('GRAY'),
    })
    const p = doc.addPage({ size: { widthPt: 100, heightPt: 100 } })
    p.content().text(t => t.setFont(PdfFont.standard('Helvetica'), 12).moveTo(10, 80).show('x'))
    await expect(doc.save()).rejects.toThrow(UnsupportedFontError)
  })

  test('setConformance after save throws', async () => {
    const doc = PdfDocument.create(deterministicOpts)
    doc.addPage({ size: { widthPt: 100, heightPt: 100 } })
    await doc.save()
    expect(() => doc.setConformance('PDF/X-4')).toThrow(PdfGenError)
  })

  test('byte-deterministic with conformance + XMP', async () => {
    const build = async () => {
      const doc = PdfDocument.create({ ...deterministicOpts, info: { title: 'Det' } })
        .setConformance('PDF/X-4')
      doc.setOutputIntent({
        subtype: 'GTS_PDFX',
        outputConditionIdentifier: 'FOGRA39',
        destOutputProfile: makeIcc('CMYK'),
      })
      const p = doc.addPage({ size: { widthPt: 200, heightPt: 200 } })
      p.setTrimBox({ x: 0, y: 0, w: 200, h: 200 })
      p.content().text(t => t.setFont(PdfFont.fromTrueType(TTF), 10).moveTo(10, 180).show('Hi'))
      return doc.save()
    }
    expect(Buffer.compare(Buffer.from(await build()), Buffer.from(await build()))).toBe(0)
  })
})
