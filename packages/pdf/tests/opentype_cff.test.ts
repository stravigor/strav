import { describe, test, expect } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import { parseCff } from '../src/fonts/cff.ts'
import { SfntFont } from '../src/fonts/sfnt.ts'
import { PdfFont } from '../src/fonts/font.ts'
import { PdfDocument } from '../src/document/pdf_document.ts'
import { expectValidPdf, deterministicOpts } from './helpers.ts'

const dec = (b: Uint8Array) => new TextDecoder('latin1').decode(b)

// Smallest CFF on macOS — a real OpenType/CFF font, ~2.5 KB.
const OTF = '/System/Library/Fonts/LastResort.otf'
const HAVE_OTF = existsSync(OTF)

/** Build a tiny but structurally valid CFF: header, Name + Top DICT INDEX,
 *  and a CharStrings INDEX whose count is `numGlyphs`. */
function makeCff(name: string, numGlyphs: number, cid: boolean): Uint8Array {
  const nameBytes = [...name].map(c => c.charCodeAt(0))
  // Name INDEX: count=1, offSize=1, offsets=[1, 1+len], data
  const nameIndex = [0, 1, 1, 1, 1 + nameBytes.length, ...nameBytes]

  // Top DICT: [ROS?] then `<csOff(28 int16)> 17` (CharStrings operator).
  const ros = cid ? [139, 139, 139, 12, 30] : [] // 3 dummy operands + ROS op
  const dictFixed = (off: number) => [...ros, 28, (off >> 8) & 0xff, off & 0xff, 17]
  const dictLen = ros.length + 4
  // Top DICT INDEX: count=1, offSize=1, offsets=[1, 1+dictLen], data
  const topIndexLen = 2 + 1 + 2 * 1 + dictLen
  const charStringsOffset = 4 + nameIndex.length + topIndexLen
  const topIndex = [0, 1, 1, 1, 1 + dictLen, ...dictFixed(charStringsOffset)]

  // CharStrings INDEX: only its count (first 2 bytes) is read by parseCff.
  const charStrings = [(numGlyphs >> 8) & 0xff, numGlyphs & 0xff, 0]

  return Uint8Array.from([1, 0, 4, 1, ...nameIndex, ...topIndex, ...charStrings])
}

describe('CFF parsing (§10.1, TN#5176)', () => {
  test('reads name, glyph count, and non-CID flag', () => {
    const info = parseCff(makeCff('SourceSansTest', 1234, false))
    expect(info.name).toBe('SourceSansTest')
    expect(info.numGlyphs).toBe(1234)
    expect(info.isCID).toBe(false)
  })

  test('detects a CID-keyed CFF via the ROS operator', () => {
    expect(parseCff(makeCff('CIDFont', 7, true)).isCID).toBe(true)
  })
})

describe('OpenType/CFF embedding (§10.1, M7 acceptance)', () => {
  test.skipIf(!HAVE_OTF)('embeds an .otf as Type0 / CIDFontType0 / FontFile3', async () => {
    const raw = new Uint8Array(readFileSync(OTF))
    const sfnt = new SfntFont(raw)
    expect(sfnt.isCFF).toBe(true)

    const doc = PdfDocument.create(deterministicOpts)
    const page = doc.addPage({ size: { widthPt: 300, heightPt: 200 } })
    page.content().text(t => t.setFont(PdfFont.fromOpenType(raw), 24).moveTo(40, 120).show('Hi'))
    const bytes = await doc.save()
    const s = dec(bytes)

    expect(s).toContain('/Subtype /Type0')
    expect(s).toContain('/Subtype /CIDFontType0')
    expect(s).toContain('/FontFile3')
    expect(s).toContain('/Subtype /CIDFontType0C')
    expect(s).toContain('/ToUnicode')
    expect(s).not.toContain('/CIDToGIDMap') // CIDFontType0 has none
    expect(s).not.toContain('/FontFile2')
    expect(s).not.toMatch(/\/BaseFont \/[A-Z]{6}\+/) // CFF not subsetted → no tag
    await expectValidPdf(bytes)
  })

  test.skipIf(!HAVE_OTF)('byte-deterministic with an embedded CFF font', async () => {
    const raw = new Uint8Array(readFileSync(OTF))
    const build = async () => {
      const doc = PdfDocument.create(deterministicOpts)
      const p = doc.addPage({ size: { widthPt: 200, heightPt: 200 } })
      p.content().text(t => t.setFont(PdfFont.fromOpenType(raw), 18).moveTo(10, 150).show('Hi'))
      return doc.save()
    }
    expect(Buffer.compare(Buffer.from(await build()), Buffer.from(await build()))).toBe(0)
  })
})
