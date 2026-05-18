import { describe, test, expect } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { parseIccProfile, iccBased } from '../src/color/icc.ts'
import { separation } from '../src/color/separation.ts'
import { deviceN } from '../src/color/devicen.ts'
import { lab, calGray } from '../src/color/cie.ts'
import { cmyk } from '../src/color/color.ts'
import { ContentStream } from '../src/content/content_stream.ts'
import { PdfDocument } from '../src/document/pdf_document.ts'
import { ObjectTable } from '../src/document/object_table.ts'
import { encodeObject } from '../src/objects/encode.ts'
import { PdfGenError } from '../src/util/errors.ts'
import { expectValidPdf, deterministicOpts } from './helpers.ts'

const dec = (b: Uint8Array) => new TextDecoder('latin1').decode(b)

/** Minimal but valid 128-byte ICC header for the given data color space. */
function makeIcc(sig: 'GRAY' | 'RGB ' | 'CMYK' | 'Lab '): Uint8Array {
  const b = new Uint8Array(132)
  const put = (o: string, off: number) => {
    for (let i = 0; i < 4; i++) b[off + i] = o.charCodeAt(i)
  }
  put('prtr', 12) // profile/device class
  put(sig, 16) // data color space
  put('Lab ', 20) // PCS
  put('acsp', 36) // signature
  return b
}

describe('ICC profile parsing (§9.2)', () => {
  test('reads color space + component count', () => {
    expect(parseIccProfile(makeIcc('CMYK')).components).toBe(4)
    expect(parseIccProfile(makeIcc('RGB ')).colorSpace).toBe('RGB')
    const g = parseIccProfile(makeIcc('GRAY'))
    expect([g.components, g.profileClass, g.pcs]).toEqual([1, 'prtr', 'Lab '])
  })

  test('rejects short data and bad signature', () => {
    expect(() => parseIccProfile(new Uint8Array(64))).toThrow(PdfGenError)
    expect(() => parseIccProfile(new Uint8Array(200))).toThrow(/acsp/)
  })
})

describe('managed color space objects (§9.1, §9.5)', () => {
  test('ICCBased → [/ICCBased <stream>] with /N and /Alternate', () => {
    const t = new ObjectTable()
    const cs = iccBased(makeIcc('CMYK'))
    const obj = dec(encodeObject(cs.build(t)))
    expect(obj).toMatch(/^\[\/ICCBased \d+ 0 R\]$/)
    const stream = dec(encodeObject(t.get(t.maxNumber)!))
    expect(stream).toContain('/N 4')
    expect(stream).toContain('/Alternate /DeviceCMYK')
    expect(cs.components).toBe(4)
  })

  test('Separation → Type-2 tint function (C0=0, C1=full)', () => {
    const t = new ObjectTable()
    const pantone = separation('PANTONE 185 C', cmyk(0, 0.91, 0.76, 0))
    const obj = dec(encodeObject(pantone.build(t)))
    expect(obj).toContain('/Separation /PANTONE#20185#20C /DeviceCMYK')
    const fn = dec(encodeObject(t.get(t.maxNumber)!))
    expect(fn).toContain('/FunctionType 2')
    expect(fn).toContain('/C0 [0 0 0 0]')
    expect(fn).toContain('/C1 [0 0.91 0.76 0]')
    expect(fn).toContain('/N 1')
  })

  test('DeviceN → Type-4 function stream', () => {
    const t = new ObjectTable()
    const dn = deviceN(['Cyan', 'Spot'], 'DeviceCMYK', '{ }')
    expect(dn.components).toBe(2)
    const obj = dec(encodeObject(dn.build(t)))
    expect(obj).toContain('/DeviceN [/Cyan /Spot] /DeviceCMYK')
    expect(dec(encodeObject(t.get(t.maxNumber)!))).toContain('/FunctionType 4')
  })

  test('Lab / CalGray array representations', () => {
    const t = new ObjectTable()
    expect(dec(encodeObject(lab().build(t)))).toContain('/Lab <</WhitePoint [0.9505 1 1.089] /Range [-100 100 -100 100] >>')
    expect(dec(encodeObject(calGray({ gamma: 2.2 }).build(t)))).toContain('/CalGray <</WhitePoint')
  })

  test('wrong component count throws', () => {
    expect(() => separation('X', cmyk(0, 0, 0, 1)).tint(0.5)).not.toThrow()
    expect(() => deviceN(['A', 'B'], 'DeviceRGB', '{}').color(0.5)).toThrow(PdfGenError)
  })
})

describe('content-stream integration', () => {
  test('separation fill emits cs + scn and registers /ColorSpace', () => {
    const cs = new ContentStream()
    const pantone = separation('Spot', cmyk(0, 1, 0, 0))
    cs.setFillColor(pantone.tint(0.6)).rect(0, 0, 10, 10).fill()
    expect(dec(cs.toBytes())).toBe('/CS1 cs\n0.6 scn\n0 0 10 10 re\nf\n')
    const res = dec(encodeObject(cs.buildResources(new ObjectTable())))
    expect(res).toContain('/ColorSpace <</CS1 [/Separation /Spot /DeviceCMYK')
  })

  test('iccBased stroke emits CS + SCN', () => {
    const cs = new ContentStream()
    const ics = iccBased(makeIcc('RGB '))
    cs.setStrokeColor(ics.color(0.2, 0.4, 0.6)).moveTo(0, 0).lineTo(1, 1).stroke()
    expect(dec(cs.toBytes())).toContain('/CS1 CS\n0.2 0.4 0.6 SCN')
  })
})

describe('output intents (§9.3)', () => {
  test('embeds the profile and wires /OutputIntents', async () => {
    const doc = PdfDocument.create(deterministicOpts)
    doc.setOutputIntent({
      subtype: 'GTS_PDFX',
      outputConditionIdentifier: 'FOGRA39',
      registryName: 'http://www.color.org',
      destOutputProfile: makeIcc('CMYK'),
    })
    const page = doc.addPage({ size: { widthPt: 200, heightPt: 200 } })
    page.content().setFillColor(separation('Spot', cmyk(0, 1, 0, 0)).tint(1)).rect(0, 0, 50, 50).fill()
    const bytes = await doc.save()
    const s = dec(bytes)
    expect(s).toContain('/OutputIntents [<</Type /OutputIntent /S /GTS_PDFX')
    expect(s).toContain('/OutputConditionIdentifier (FOGRA39)')
    expect(s).toContain('/DestOutputProfile ')
    expect(s).toContain('/N 4') // embedded profile component count
    await expectValidPdf(bytes)
  })

  test('byte-deterministic with managed color + output intent', async () => {
    const build = async () => {
      const doc = PdfDocument.create(deterministicOpts)
      doc.setOutputIntent({
        subtype: 'GTS_PDFX',
        outputConditionIdentifier: 'FOGRA39',
        destOutputProfile: makeIcc('CMYK'),
      })
      const p = doc.addPage({ size: { widthPt: 100, heightPt: 100 } })
      p.content().setFillColor(separation('S', cmyk(0, 1, 0.5, 0)).tint(0.7)).rect(0, 0, 100, 100).fill()
      return doc.save()
    }
    expect(Buffer.compare(Buffer.from(await build()), Buffer.from(await build()))).toBe(0)
  })

  const SYS_ICC = [
    '/System/Library/ColorSync/Profiles/Generic CMYK Profile.icc',
    '/System/Library/ColorSync/Profiles/sRGB Profile.icc',
  ].find(p => existsSync(p))

  test.skipIf(!SYS_ICC)('parses a real system ICC profile', () => {
    const prof = parseIccProfile(new Uint8Array(readFileSync(SYS_ICC!)))
    expect(['GRAY', 'RGB', 'CMYK', 'Lab']).toContain(prof.colorSpace)
    expect([1, 3, 4]).toContain(prof.components)
  })
})
