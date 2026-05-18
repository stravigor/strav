import { describe, test, expect } from 'bun:test'
import { extGState } from '../src/ext-gstate/ext_gstate.ts'
import { tilingPattern } from '../src/patterns/tiling_pattern.ts'
import { axialShading, radialShading, shadingPattern } from '../src/patterns/shading.ts'
import { rgb, gray } from '../src/color/color.ts'
import { ContentStream } from '../src/content/content_stream.ts'
import { PdfDocument } from '../src/document/pdf_document.ts'
import { ObjectTable } from '../src/document/object_table.ts'
import { encodeObject } from '../src/objects/encode.ts'
import { expectValidPdf, deterministicOpts } from './helpers.ts'

const dec = (b: Uint8Array) => new TextDecoder('latin1').decode(b)

describe('ExtGState (§13)', () => {
  test('builds CA/ca/BM and emits gs', () => {
    const t = new ObjectTable()
    const gs = extGState({ strokeAlpha: 0.5, fillAlpha: 0.5, blendMode: 'Multiply' })
    expect(dec(encodeObject(gs.build(t)))).toBe(
      '<</Type /ExtGState /CA 0.5 /ca 0.5 /BM /Multiply >>'
    )
    const cs = new ContentStream()
    cs.setExtGState(gs).rect(0, 0, 1, 1).fill()
    expect(dec(cs.toBytes())).toBe('/GS1 gs\n0 0 1 1 re\nf\n')
    expect(dec(encodeObject(cs.buildResources(t)))).toContain('/ExtGState <</GS1 <</Type /ExtGState')
  })
})

describe('tiling patterns (§12.1)', () => {
  test('builds a Pattern stream with its own resources', () => {
    const t = new ObjectTable()
    const stripes = tilingPattern({
      bbox: [0, 0, 10, 10],
      xStep: 10,
      yStep: 10,
      draw: c => {
        c.setFillColor(rgb(0, 0, 0)).rect(0, 0, 5, 10).fill()
      },
    })
    const ref = stripes.build(t)
    const s = dec(encodeObject(t.get((ref as { num: number }).num)!))
    expect(s).toContain('/Type /Pattern')
    expect(s).toContain('/PatternType 1')
    expect(s).toContain('/PaintType 1')
    expect(s).toContain('/BBox [0 0 10 10]')
    expect(s).toContain('/XStep 10')
    expect(s).toContain('/Resources <<')
    expect(s).toContain('/Filter /FlateDecode')
  })

  test('setFillPattern emits /Pattern cs + scn and registers /Pattern', () => {
    const cs = new ContentStream()
    const p = tilingPattern({ bbox: [0, 0, 4, 4], xStep: 4, yStep: 4, draw: c => c.rect(0, 0, 2, 2).fill() })
    cs.setFillPattern(p).rect(0, 0, 100, 100).fill()
    expect(dec(cs.toBytes())).toBe('/Pattern cs\n/P1 scn\n0 0 100 100 re\nf\n')
    expect(dec(encodeObject(cs.buildResources(new ObjectTable())))).toContain('/Pattern <</P1 ')
  })
})

describe('shadings (§12.2)', () => {
  test('axial = ShadingType 2, two stops → Type-2 function', () => {
    const t = new ObjectTable()
    const sh = axialShading({ from: [0, 0], to: [100, 0], colors: [rgb(1, 0, 0), rgb(0, 0, 1)] })
    const s = dec(encodeObject(sh.build(t)))
    expect(s).toContain('/ShadingType 2')
    expect(s).toContain('/ColorSpace /DeviceRGB')
    expect(s).toContain('/Coords [0 0 100 0]')
    expect(s).toContain('/FunctionType 2')
    expect(s).toContain('/C0 [1 0 0]')
    expect(s).toContain('/C1 [0 0 1]')
    expect(s).toContain('/Extend [true true]')
  })

  test('radial = ShadingType 3 with 6 coords; 3 stops → Type-3 stitch', () => {
    const t = new ObjectTable()
    const sh = radialShading({
      from: { x: 50, y: 50, r: 0 },
      to: { x: 50, y: 50, r: 40 },
      colors: [gray(1), gray(0.5), gray(0)],
    })
    const s = dec(encodeObject(sh.build(t)))
    expect(s).toContain('/ShadingType 3')
    expect(s).toContain('/Coords [50 50 0 50 50 40]')
    expect(s).toContain('/FunctionType 3')
    expect(s).toContain('/Functions [')
  })

  test('shade() emits sh and registers /Shading', () => {
    const cs = new ContentStream()
    const sh = axialShading({ from: [0, 0], to: [10, 10], colors: [rgb(1, 1, 0), rgb(0, 1, 1)] })
    cs.shade(sh)
    expect(dec(cs.toBytes())).toBe('/Sh1 sh\n')
    expect(dec(encodeObject(cs.buildResources(new ObjectTable())))).toContain(
      '/Shading <</Sh1 <</ShadingType 2'
    )
  })

  test('shadingPattern usable as a fill pattern', () => {
    const t = new ObjectTable()
    const sp = shadingPattern(axialShading({ from: [0, 0], to: [1, 0], colors: [gray(0), gray(1)] }))
    const ref = sp.build(t)
    expect(dec(encodeObject(t.get((ref as { num: number }).num)!))).toContain(
      '/Type /Pattern /PatternType 2 /Shading <<'
    )
  })

  test('a shading needs ≥2 stops', () => {
    expect(() =>
      axialShading({ from: [0, 0], to: [1, 0], colors: [rgb(0, 0, 0)] }).build(new ObjectTable())
    ).toThrow()
  })
})

describe('document integration (M10 acceptance)', () => {
  test('overlapping translucent shapes + pattern + gradient render valid', async () => {
    const doc = PdfDocument.create(deterministicOpts)
    const page = doc.addPage({ size: { widthPt: 240, heightPt: 200 } })
    const half = doc.createExtGState({ fillAlpha: 0.5, blendMode: 'Multiply' })
    const dots = doc.createTilingPattern({
      bbox: [0, 0, 12, 12],
      xStep: 12,
      yStep: 12,
      draw: c => c.setFillColor(rgb(0.1, 0.4, 0.8)).rect(2, 2, 6, 6).fill(),
    })
    const grad = doc.createAxialShading({
      from: [0, 0],
      to: [240, 0],
      colors: [rgb(1, 0.6, 0), rgb(0.6, 0, 0.7)],
    })
    page
      .content()
      .save()
      .shade(grad) // background gradient
      .restore()
      .save()
      .setExtGState(half)
      .setFillColor(rgb(1, 0, 0))
      .rect(20, 40, 120, 120)
      .fill()
      .setFillColor(rgb(0, 0, 1))
      .rect(80, 40, 120, 120)
      .fill()
      .restore()
      .save()
      .setFillPattern(dots)
      .rect(20, 20, 200, 16)
      .fill()
      .restore()
    await expectValidPdf(await doc.save())
  })

  test('byte-deterministic with ExtGState + pattern + shading', async () => {
    const build = async () => {
      const doc = PdfDocument.create(deterministicOpts)
      const p = doc.addPage({ size: { widthPt: 100, heightPt: 100 } })
      const g = doc.createExtGState({ fillAlpha: 0.3 })
      const sh = doc.createAxialShading({ from: [0, 0], to: [100, 100], colors: [gray(0), gray(1)] })
      p.content().save().setExtGState(g).shade(sh).restore()
      return doc.save()
    }
    expect(Buffer.compare(Buffer.from(await build()), Buffer.from(await build()))).toBe(0)
  })
})
