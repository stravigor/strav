import { describe, test, expect } from 'bun:test'
import { flateEncode, flateDecode } from '../src/streams/flate.ts'
import { ascii85Encode, ascii85Decode } from '../src/streams/ascii85.ts'
import { asciiHexEncode, asciiHexDecode } from '../src/streams/ascii_hex.ts'
import { makeStream, makeContentStream, MIN_FILTER_BYTES } from '../src/streams/stream.ts'
import { PdfDocument } from '../src/document/pdf_document.ts'
import { expectValidPdf, deterministicOpts } from './helpers.ts'

const bytesOf = (s: string) => new TextEncoder().encode(s)
const dec = (b: Uint8Array) => new TextDecoder('latin1').decode(b)

describe('FlateDecode (§7.2)', () => {
  test('round-trips and is deterministic at level 9', () => {
    const data = bytesOf('the quick brown fox '.repeat(50))
    const a = flateEncode(data)
    const b = flateEncode(data)
    expect(Buffer.compare(Buffer.from(a), Buffer.from(b))).toBe(0)
    expect(Buffer.compare(Buffer.from(flateDecode(a)), Buffer.from(data))).toBe(0)
  })
})

describe('ASCII85 / ASCIIHex (§7.1)', () => {
  test('ASCII85 round-trips, ends with ~>, uses z for zero group', () => {
    const data = Uint8Array.from([0, 0, 0, 0, 1, 2, 3, 4, 9])
    const enc = ascii85Encode(data)
    expect(dec(enc).startsWith('z')).toBe(true)
    expect(dec(enc).endsWith('~>')).toBe(true)
    expect(Buffer.compare(Buffer.from(ascii85Decode(enc)), Buffer.from(data))).toBe(0)
  })

  test('ASCIIHex round-trips and ends with >', () => {
    const data = Uint8Array.from([0xde, 0xad, 0xbe, 0xef])
    const enc = asciiHexEncode(data)
    expect(dec(enc)).toBe('DEADBEEF>')
    expect(Buffer.compare(Buffer.from(asciiHexDecode(enc)), Buffer.from(data))).toBe(0)
  })
})

describe('stream construction policy (§7.3)', () => {
  test('tiny data is left unfiltered', () => {
    const s = makeStream(bytesOf('hi'))
    expect(s.dict.entries.has('Filter')).toBe(false)
  })

  test('data ≥ threshold is FlateDecoded', () => {
    const s = makeStream(bytesOf('x'.repeat(MIN_FILTER_BYTES)))
    expect((s.dict.entries.get('Filter') as { value: string }).value).toBe('FlateDecode')
    expect((s.dict.entries.get('Length') as { value: number }).value).toBe(s.data.length)
    expect(Buffer.compare(Buffer.from(flateDecode(s.data)), Buffer.from('x'.repeat(64)))).toBe(0)
  })

  test('alreadyCompressed data is never re-filtered', () => {
    const s = makeStream(bytesOf('y'.repeat(200)), { alreadyCompressed: true })
    expect(s.dict.entries.has('Filter')).toBe(false)
  })

  test('content stream auto-compresses and PDF stays valid', async () => {
    const doc = PdfDocument.create(deterministicOpts)
    const p = doc.addPage({ size: { widthPt: 400, heightPt: 400 } })
    const c = p.content()
    for (let i = 0; i < 80; i++) c.rect(i, i, 5, 5).fill()
    const bytes = await doc.save()
    expect(dec(bytes)).toContain('/Filter /FlateDecode')
    await expectValidPdf(bytes)
  })

  test('makeContentStream below threshold stays raw', () => {
    const s = makeContentStream(bytesOf('q\nQ\n'))
    expect(s.dict.entries.has('Filter')).toBe(false)
  })
})
