import { describe, test, expect } from 'bun:test'
import { parseJpeg } from '../src/images/jpeg.ts'
import { parsePng } from '../src/images/png.ts'
import { PdfImage } from '../src/images/image.ts'
import { ContentStream } from '../src/content/content_stream.ts'
import { PdfDocument } from '../src/document/pdf_document.ts'
import { ObjectTable } from '../src/document/object_table.ts'
import { encodeObject } from '../src/objects/encode.ts'
import { InvalidImageError } from '../src/util/errors.ts'
import { expectValidPdf, deterministicOpts } from './helpers.ts'
import { makePng, solidRgbPng, checkerRgbaPng } from './fixtures/make_png.ts'
import { RED_JPEG } from './fixtures/red_jpeg.ts'

const dec = (b: Uint8Array) => new TextDecoder('latin1').decode(b)

/** Minimal marker-only JPEG (no real entropy data) for parser tests. */
function makeJpeg(w: number, h: number, comp: 1 | 3 | 4, opts: { adobe?: boolean; precision?: number } = {}) {
  const p = opts.precision ?? 8
  const b: number[] = [0xff, 0xd8] // SOI
  if (opts.adobe) {
    b.push(0xff, 0xee, 0x00, 14, 0x41, 0x64, 0x6f, 0x62, 0x65, 0, 0, 0, 0, 0, 0, 0)
  }
  const sofLen = 8 + 3 * comp
  b.push(0xff, 0xc0, (sofLen >> 8) & 0xff, sofLen & 0xff, p, (h >> 8) & 0xff, h & 0xff, (w >> 8) & 0xff, w & 0xff, comp)
  for (let i = 0; i < comp; i++) b.push(i + 1, 0x11, 0)
  b.push(0xff, 0xda, 0, 2, 0xff, 0xd9) // SOS (empty) + EOI
  return Uint8Array.from(b)
}

describe('JPEG marker parsing (§11.1)', () => {
  test('reads dimensions, components, Adobe-inversion', () => {
    const g = parseJpeg(makeJpeg(40, 30, 1))
    expect([g.width, g.height, g.components, g.adobeInverted]).toEqual([40, 30, 1, false])
    expect(parseJpeg(makeJpeg(8, 8, 3)).components).toBe(3)
    const cmyk = parseJpeg(makeJpeg(10, 10, 4, { adobe: true }))
    expect(cmyk.components).toBe(4)
    expect(cmyk.adobeInverted).toBe(true) // Photoshop CMYK convention
  })

  test('rejects 12-bit and non-JPEG input', () => {
    expect(() => parseJpeg(makeJpeg(8, 8, 3, { precision: 12 }))).toThrow(InvalidImageError)
    expect(() => parseJpeg(Uint8Array.from([1, 2, 3, 4]))).toThrow(InvalidImageError)
  })

  test('parses a real baseline JPEG (skips its APP2 ICC segment)', () => {
    const j = parseJpeg(RED_JPEG)
    expect([j.width, j.height, j.components, j.bitsPerComponent]).toEqual([8, 8, 3, 8])
  })
})

describe('PNG decoding (§11.2)', () => {
  test('RGB truecolor', () => {
    const p = parsePng(solidRgbPng(200, 50, 10))
    expect([p.width, p.height]).toEqual([2, 2])
    expect(p.colorSpace.kind).toBe('DeviceRGB')
    expect(p.samples.length).toBe(2 * 2 * 3)
    expect(p.alpha).toBeUndefined()
  })

  test('grayscale', () => {
    const p = parsePng(makePng({ width: 2, height: 1, colorType: 0, samples: [10, 240] }))
    expect(p.colorSpace.kind).toBe('DeviceGray')
    expect([...p.samples]).toEqual([10, 240])
  })

  test('indexed with per-palette tRNS → soft mask', () => {
    const p = parsePng(
      makePng({
        width: 2,
        height: 1,
        colorType: 3,
        samples: [0, 1],
        palette: [255, 0, 0, 0, 255, 0],
        trns: [0, 128], // index 0 transparent, index 1 half
      })
    )
    expect(p.colorSpace.kind).toBe('Indexed')
    if (p.colorSpace.kind === 'Indexed') expect(p.colorSpace.hival).toBe(1)
    expect([...(p.alpha ?? [])]).toEqual([0, 128])
  })

  test('RGBA splits the alpha channel', () => {
    const p = parsePng(checkerRgbaPng())
    expect(p.colorSpace.kind).toBe('DeviceRGB')
    expect(p.samples.length).toBe(2 * 2 * 3)
    expect(p.alpha!.length).toBe(2 * 2)
    expect([...p.alpha!]).toEqual([255, 128, 0, 255])
  })

  test('rejects interlaced and 16-bit PNGs', () => {
    const png = makePng({ width: 1, height: 1, colorType: 2, samples: [0, 0, 0] })
    png[28] = 1 // IHDR interlace byte → Adam7
    expect(() => parsePng(png)).toThrow(/[Ii]nterlac/)
    expect(() =>
      parsePng(makePng({ width: 1, height: 1, colorType: 2, bitDepth: 16, samples: [0, 0, 0, 0, 0, 0] }))
    ).toThrow(/16-bit/)
  })
})

describe('image XObject emission (§11.3)', () => {
  test('JPEG → /DCTDecode, verbatim, device color space', () => {
    const t = new ObjectTable()
    const ref = PdfImage.fromJpeg(RED_JPEG).register(t)
    const s = dec(encodeObject(t.get(ref.num)!))
    expect(s).toContain('/Subtype /Image')
    expect(s).toContain('/Filter /DCTDecode')
    expect(s).toContain('/Width 8')
    expect(s).toContain('/ColorSpace /DeviceRGB')
  })

  test('CMYK Adobe JPEG gets the /Decode inversion', () => {
    const t = new ObjectTable()
    const ref = PdfImage.fromJpeg(makeJpeg(4, 4, 4, { adobe: true })).register(t)
    expect(dec(encodeObject(t.get(ref.num)!))).toContain('/Decode [1 0 1 0 1 0 1 0]')
  })

  test('PNG → /FlateDecode; alpha adds an /SMask object', () => {
    const t = new ObjectTable()
    const ref = PdfImage.fromPng(checkerRgbaPng()).register(t)
    const s = dec(encodeObject(t.get(ref.num)!))
    expect(s).toContain('/Filter /FlateDecode')
    expect(s).toContain('/SMask ')
    // The SMask object (added before the image) is a DeviceGray image.
    const sm = dec(encodeObject(t.get(ref.num - 1)!))
    expect(sm).toContain('/ColorSpace /DeviceGray')
  })

  test('indexed PNG → /Indexed color space array', () => {
    const t = new ObjectTable()
    const ref = PdfImage.fromPng(
      makePng({ width: 1, height: 1, colorType: 3, samples: [0], palette: [1, 2, 3] })
    ).register(t)
    expect(dec(encodeObject(t.get(ref.num)!))).toContain('/ColorSpace [/Indexed /DeviceRGB 0 <010203>]')
  })

  test('drawImage emits q/cm/Do/Q and registers an /XObject', () => {
    const cs = new ContentStream()
    cs.drawImage(PdfImage.fromPng(solidRgbPng(0, 0, 0)), { x: 10, y: 20, width: 100, height: 50 })
    expect(dec(cs.toBytes())).toBe('q\n100 0 0 50 10 20 cm\n/Im1 Do\nQ\n')
    const res = dec(encodeObject(cs.buildResources(new ObjectTable())))
    expect(res).toContain('/XObject <</Im1 ')
  })
})

describe('document integration (M8 acceptance)', () => {
  test('mixed JPEG + PNG (with alpha over a color) is a valid PDF', async () => {
    const doc = PdfDocument.create(deterministicOpts)
    const page = doc.addPage({ size: { widthPt: 200, heightPt: 200 } })
    page
      .content()
      .save()
      .setFillColor({ space: 'DeviceRGB', r: 0.2, g: 0.5, b: 0.9 })
      .rect(0, 0, 200, 200)
      .fill()
      .restore()
      .drawImage(PdfImage.fromJpeg(RED_JPEG), { x: 20, y: 120, width: 60, height: 60 })
      .drawImage(PdfImage.fromPng(checkerRgbaPng()), { x: 100, y: 120, width: 60, height: 60 })
    await expectValidPdf(await doc.save())
  })

  test('byte-deterministic with images', async () => {
    const build = async () => {
      const doc = PdfDocument.create(deterministicOpts)
      const p = doc.addPage({ size: { widthPt: 100, heightPt: 100 } })
      p.content()
        .drawImage(PdfImage.fromPng(solidRgbPng(10, 20, 30)), { x: 0, y: 0, width: 100, height: 100 })
        .drawImage(PdfImage.fromJpeg(RED_JPEG), { x: 10, y: 10, width: 20, height: 20 })
      return doc.save()
    }
    expect(Buffer.compare(Buffer.from(await build()), Buffer.from(await build()))).toBe(0)
  })
})
