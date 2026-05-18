/**
 * Hermetic PNG generator for tests — no committed binary, no network.
 * Builds a valid PNG (signature, IHDR, optional PLTE/tRNS, IDAT with filter-0
 * scanlines, IEND) with correct CRC32s. The real parser decodes it.
 */

import { deflateSync } from 'node:zlib'

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(bytes: number[]): number {
  let c = 0xffffffff
  for (const b of bytes) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function be32(v: number): number[] {
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]
}

function chunk(type: string, data: number[]): number[] {
  const typeBytes = [...type].map(c => c.charCodeAt(0))
  const crc = crc32([...typeBytes, ...data])
  return [...be32(data.length), ...typeBytes, ...data, ...be32(crc)]
}

export interface PngSpec {
  width: number
  height: number
  /** 0 gray, 2 RGB, 3 indexed, 4 gray+alpha, 6 RGBA. */
  colorType: 0 | 2 | 3 | 4 | 6
  bitDepth?: number
  /** Raw samples, row-major, channels per colorType (no filter bytes). */
  samples: number[]
  /** RGB triples for colorType 3. */
  palette?: number[]
  /** tRNS chunk payload (per-index alpha, or color key). */
  trns?: number[]
}

export function makePng(spec: PngSpec): Uint8Array {
  const bitDepth = spec.bitDepth ?? 8
  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[spec.colorType]
  const rowBytes = Math.ceil((spec.width * channels * bitDepth) / 8)

  // Prepend a filter-type-0 byte to each scanline, then deflate.
  const rows: number[] = []
  for (let y = 0; y < spec.height; y++) {
    rows.push(0)
    for (let x = 0; x < rowBytes; x++) rows.push(spec.samples[y * rowBytes + x] ?? 0)
  }
  const idat = [...deflateSync(Uint8Array.from(rows), { level: 9 })]

  const ihdr = [
    ...be32(spec.width),
    ...be32(spec.height),
    bitDepth,
    spec.colorType,
    0, // compression
    0, // filter
    0, // interlace
  ]

  const out: number[] = [...SIG, ...chunk('IHDR', ihdr)]
  if (spec.palette) out.push(...chunk('PLTE', spec.palette))
  if (spec.trns) out.push(...chunk('tRNS', spec.trns))
  out.push(...chunk('IDAT', idat), ...chunk('IEND', []))
  return Uint8Array.from(out)
}

/** Solid 2×2 RGB image of one color. */
export function solidRgbPng(r: number, g: number, b: number): Uint8Array {
  const px = [r, g, b]
  return makePng({
    width: 2,
    height: 2,
    colorType: 2,
    samples: [...px, ...px, ...px, ...px],
  })
}

/** 2×2 RGBA: opaque, then half-alpha, then transparent, then opaque. */
export function checkerRgbaPng(): Uint8Array {
  return makePng({
    width: 2,
    height: 2,
    colorType: 6,
    samples: [
      255, 0, 0, 255, 0, 128, 255, 128,
      0, 200, 0, 0, 255, 255, 0, 255,
    ],
  })
}
