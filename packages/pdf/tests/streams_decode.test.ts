import { describe, test, expect } from 'bun:test'
import { deflateSync } from 'node:zlib'
import { flateEncode, flateDecode, unpredict } from '../src/streams/flate.ts'
import { lzwDecode } from '../src/streams/lzw.ts'
import { runLengthDecode } from '../src/streams/runlength.ts'
import { ascii85Encode } from '../src/streams/ascii85.ts'
import { asciiHexEncode } from '../src/streams/ascii_hex.ts'
import { decodeStream } from '../src/streams/decode.ts'
import { dict, name, num, arr, type PdfObject } from '../src/objects/types.ts'

const bytesOf = (s: string) => new TextEncoder().encode(s)
const eq = (a: Uint8Array, b: Uint8Array) => Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0

describe('FlateDecode predictors (§7.4.4.4)', () => {
  test('PNG predictor 12 (Up) round-trips through unpredict', () => {
    // Build 3 rows of 4 bytes, prefix each with PNG filter byte 2 (Up).
    const rows = [
      [10, 20, 30, 40],
      [11, 22, 33, 44],
      [12, 24, 36, 48],
    ]
    const raw: number[] = []
    let prev = [0, 0, 0, 0]
    for (const r of rows) {
      raw.push(2)
      for (let i = 0; i < 4; i++) raw.push((r[i]! - prev[i]!) & 0xff)
      prev = r
    }
    const out = unpredict(Uint8Array.from(raw), {
      predictor: 12,
      colors: 1,
      bitsPerComponent: 8,
      columns: 4,
    })
    expect([...out]).toEqual(rows.flat())
  })

  test('TIFF predictor 2 reverses horizontal differencing', () => {
    const original = Uint8Array.from([5, 10, 15, 1, 2, 3])
    const diffed = original.slice()
    for (let r = 0; r < diffed.length; r += 3) {
      for (let i = 2; i >= 1; i--) {
        diffed[r + i] = (original[r + i]! - original[r + i - 1]!) & 0xff
      }
    }
    const out = unpredict(diffed, {
      predictor: 2,
      colors: 1,
      bitsPerComponent: 8,
      columns: 3,
    })
    expect(eq(out, original)).toBe(true)
  })

  test('flateDecode applies predictor when params given', () => {
    const rows = [
      [1, 2, 3],
      [4, 5, 6],
    ]
    const raw: number[] = []
    let prev = [0, 0, 0]
    for (const r of rows) {
      raw.push(2)
      for (let i = 0; i < 3; i++) raw.push((r[i]! - prev[i]!) & 0xff)
      prev = r
    }
    const z = new Uint8Array(deflateSync(Uint8Array.from(raw), { level: 9 }))
    const out = flateDecode(z, { predictor: 12, columns: 3 })
    expect([...out]).toEqual([1, 2, 3, 4, 5, 6])
  })
})

describe('RunLengthDecode (§7.4.5)', () => {
  test('literal and repeat runs, EOD', () => {
    // literal "AB" (len 1 → 2 bytes), repeat 'C' x4 (257-253=4), EOD
    const data = Uint8Array.from([1, 0x41, 0x42, 253, 0x43, 128])
    expect(new TextDecoder().decode(runLengthDecode(data))).toBe('ABCCCC')
  })
})

describe('LZWDecode (§7.4.4)', () => {
  test('decodes a known TIFF/PDF LZW sample', () => {
    // Classic spec example: input "-----A---B" style not needed; use a
    // self-built stream via the canonical LZW for bytes [45,45,45...] is
    // complex — instead verify clear/EOD framing on a trivial encoder output.
    // Encode "TOBEORNOTTOBEORTOBEORNOT" with a tiny MSB-first LZW encoder.
    const input = bytesOf('TOBEORNOTTOBEORTOBEORNOT')
    const enc = lzwEncode(input)
    expect(eq(lzwDecode(enc), input)).toBe(true)
  })
})

describe('decodeStream dispatch (§7.4)', () => {
  test('chained ASCII85 + Flate', () => {
    const original = bytesOf('chained filters payload '.repeat(8))
    const fl = flateEncode(original)
    const a85 = ascii85Encode(fl)
    const d = dict({ Filter: arr([name('ASCII85Decode'), name('FlateDecode')]) })
    expect(eq(decodeStream(d, a85), original)).toBe(true)
  })

  test('single ASCIIHexDecode by name', () => {
    const original = Uint8Array.from([0xca, 0xfe, 0xba, 0xbe])
    const d = dict({ Filter: name('ASCIIHexDecode') })
    expect(eq(decodeStream(d, asciiHexEncode(original)), original)).toBe(true)
  })

  test('image filters are returned untouched (terminal)', () => {
    const jpegish = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0])
    const d = dict({ Filter: name('DCTDecode') })
    expect(eq(decodeStream(d, jpegish), jpegish)).toBe(true)
  })

  test('no filter returns data unchanged', () => {
    const data = bytesOf('plain')
    expect(eq(decodeStream(dict({}), data), data)).toBe(true)
  })

  test('Flate with predictor via DecodeParms', () => {
    const rows = [
      [9, 8, 7],
      [6, 5, 4],
    ]
    const raw: number[] = []
    let prev = [0, 0, 0]
    for (const r of rows) {
      raw.push(2)
      for (let i = 0; i < 3; i++) raw.push((r[i]! - prev[i]!) & 0xff)
      prev = r
    }
    const z = flateEncode(Uint8Array.from(raw))
    const d = dict({
      Filter: name('FlateDecode'),
      DecodeParms: dict({ Predictor: num(12), Columns: num(3) }),
    }) as PdfObject as ReturnType<typeof dict>
    expect([...decodeStream(d, z)]).toEqual([9, 8, 7, 6, 5, 4])
  })
})

// Minimal MSB-first LZW encoder mirroring the PDF/TIFF variant (earlyChange=1)
// — test-only, exercises lzwDecode against a real bitstream.
function lzwEncode(input: Uint8Array): Uint8Array {
  const out: number[] = []
  let bitBuf = 0
  let bitCnt = 0
  const emit = (code: number, width: number) => {
    bitBuf = (bitBuf << width) | code
    bitCnt += width
    while (bitCnt >= 8) {
      bitCnt -= 8
      out.push((bitBuf >> bitCnt) & 0xff)
    }
  }
  let table = new Map<string, number>()
  const reset = () => {
    table = new Map()
    for (let i = 0; i < 256; i++) table.set(String.fromCharCode(i), i)
  }
  reset()
  let next = 258
  let width = 9
  emit(256, width) // clear
  let w = ''
  for (const c of input) {
    const wc = w + String.fromCharCode(c)
    if (table.has(wc)) {
      w = wc
    } else {
      emit(table.get(w)!, width)
      table.set(wc, next++)
      if (next + 1 > 1 << width && width < 12) width++
      w = String.fromCharCode(c)
    }
  }
  if (w !== '') emit(table.get(w)!, width)
  emit(257, width) // EOD
  if (bitCnt > 0) out.push((bitBuf << (8 - bitCnt)) & 0xff)
  return Uint8Array.from(out)
}
