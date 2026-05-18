/**
 * PNG parsing (spec §11.2).
 *
 * PDF has no PNG filter, so we decode: parse chunks, inflate IDAT, undo the
 * PNG line filters, and hand back raw samples (re-encoded as FlateDecode by
 * image.ts, with no PDF predictor in v1). Alpha (color type 4/6 or `tRNS`) is
 * split into a separate soft-mask plane; an indexed PNG keeps its palette.
 *
 * Limits (v1): interlaced PNGs and 16-bit depth are rejected; an embedded
 * `iCCP` profile is ignored (device color space) until ICC support (M9).
 */

import { InvalidImageError } from '../util/errors.ts'
import { flateDecode } from '../streams/flate.ts'

export type PngColorSpace =
  | { kind: 'DeviceGray' }
  | { kind: 'DeviceRGB' }
  | { kind: 'Indexed'; palette: Uint8Array; hival: number }

export interface PngImageData {
  width: number
  height: number
  bitsPerComponent: number
  colorSpace: PngColorSpace
  /** Color samples, line-filters removed (no alpha). */
  samples: Uint8Array
  /** 8-bit alpha plane (width×height), if the image has transparency. */
  alpha?: Uint8Array
  /** Color-key mask `[min max …]` for `tRNS` on gray/RGB images. */
  colorKey?: number[]
}

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function u32(b: Uint8Array, o: number): number {
  return ((b[o]! << 24) | (b[o + 1]! << 16) | (b[o + 2]! << 8) | b[o + 3]!) >>> 0
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  return pb <= pc ? b : c
}

/** Reverse the PNG line filters, returning `height` rows of `rowBytes`. */
function unfilter(
  raw: Uint8Array,
  height: number,
  rowBytes: number,
  bpp: number
): Uint8Array {
  const out = new Uint8Array(height * rowBytes)
  let pos = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[pos++]!
    const o = y * rowBytes
    const p = (y - 1) * rowBytes
    for (let x = 0; x < rowBytes; x++) {
      const v = raw[pos++]!
      const a = x >= bpp ? out[o + x - bpp]! : 0
      const b = y > 0 ? out[p + x]! : 0
      const c = y > 0 && x >= bpp ? out[p + x - bpp]! : 0
      let s: number
      switch (filter) {
        case 0:
          s = v
          break
        case 1:
          s = v + a
          break
        case 2:
          s = v + b
          break
        case 3:
          s = v + ((a + b) >> 1)
          break
        case 4:
          s = v + paeth(a, b, c)
          break
        default:
          throw new InvalidImageError(`Unknown PNG filter type ${filter}`)
      }
      out[o + x] = s & 0xff
    }
  }
  return out
}

export function parsePng(data: Uint8Array): PngImageData {
  for (let i = 0; i < 8; i++) {
    if (data[i] !== SIG[i]) throw new InvalidImageError('Not a PNG (bad signature)')
  }

  let width = 0
  let height = 0
  let bitDepth = 8
  let colorType = 0
  let palette: Uint8Array | undefined
  let trns: Uint8Array | undefined
  const idat: Uint8Array[] = []

  let pos = 8
  while (pos + 8 <= data.length) {
    const len = u32(data, pos)
    const type = String.fromCharCode(
      data[pos + 4]!,
      data[pos + 5]!,
      data[pos + 6]!,
      data[pos + 7]!
    )
    const body = data.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = u32(body, 0)
      height = u32(body, 4)
      bitDepth = body[8]!
      colorType = body[9]!
      if (body[12] !== 0) {
        throw new InvalidImageError('Interlaced PNGs are not supported (de-interlace first)')
      }
    } else if (type === 'PLTE') {
      palette = body.slice()
    } else if (type === 'tRNS') {
      trns = body.slice()
    } else if (type === 'IDAT') {
      idat.push(body.slice())
    } else if (type === 'IEND') {
      break
    }
    pos += 12 + len // length + type + data + CRC
  }

  if (bitDepth === 16) {
    throw new InvalidImageError('16-bit PNGs are not supported in v1 (downsample to 8-bit)')
  }

  const channels = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[colorType]
  if (channels === undefined) {
    throw new InvalidImageError(`Unsupported PNG color type ${colorType}`)
  }
  if (colorType !== 0 && colorType !== 3 && bitDepth !== 8) {
    throw new InvalidImageError(`Unsupported PNG bit depth ${bitDepth} for color type ${colorType}`)
  }

  // Concatenate + inflate IDAT, then undo line filters.
  let total = 0
  for (const c of idat) total += c.length
  const comp = new Uint8Array(total)
  {
    let o = 0
    for (const c of idat) {
      comp.set(c, o)
      o += c.length
    }
  }
  const rowBytes = Math.ceil((width * channels * bitDepth) / 8)
  const bpp = Math.max(1, Math.ceil((channels * bitDepth) / 8))
  const raw = unfilter(flateDecode(comp), height, rowBytes, bpp)

  // Split colour vs. alpha and pick the PDF color space.
  if (colorType === 0) {
    const res: PngImageData = {
      width,
      height,
      bitsPerComponent: bitDepth,
      colorSpace: { kind: 'DeviceGray' },
      samples: raw,
    }
    if (trns && trns.length >= 2) res.colorKey = [trns[1]!, trns[1]!]
    return res
  }
  if (colorType === 2) {
    const res: PngImageData = {
      width,
      height,
      bitsPerComponent: 8,
      colorSpace: { kind: 'DeviceRGB' },
      samples: raw,
    }
    if (trns && trns.length >= 6) {
      res.colorKey = [trns[1]!, trns[1]!, trns[3]!, trns[3]!, trns[5]!, trns[5]!]
    }
    return res
  }
  if (colorType === 3) {
    if (!palette) throw new InvalidImageError('Indexed PNG missing PLTE chunk')
    const res: PngImageData = {
      width,
      height,
      bitsPerComponent: bitDepth,
      colorSpace: { kind: 'Indexed', palette, hival: palette.length / 3 - 1 },
      samples: raw,
    }
    if (trns) {
      // Per-palette-entry alpha → an 8-bit soft mask plane.
      const alpha = new Uint8Array(width * height)
      const perRow = rowBytes
      let k = 0
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = readIndex(raw, y * perRow, x, bitDepth)
          alpha[k++] = idx < trns.length ? trns[idx]! : 255
        }
      }
      res.alpha = alpha
    }
    return res
  }
  // colorType 4 (gray+alpha) or 6 (RGBA) — 8-bit, split the alpha channel.
  const colorCh = colorType === 4 ? 1 : 3
  const px = width * height
  const samples = new Uint8Array(px * colorCh)
  const alpha = new Uint8Array(px)
  for (let i = 0; i < px; i++) {
    const src = i * (colorCh + 1)
    for (let ch = 0; ch < colorCh; ch++) samples[i * colorCh + ch] = raw[src + ch]!
    alpha[i] = raw[src + colorCh]!
  }
  return {
    width,
    height,
    bitsPerComponent: 8,
    colorSpace: colorType === 4 ? { kind: 'DeviceGray' } : { kind: 'DeviceRGB' },
    samples,
    alpha,
  }
}

/** Read the palette index of pixel `x` in a sub-byte-packed scanline. */
function readIndex(raw: Uint8Array, rowOff: number, x: number, bitDepth: number): number {
  if (bitDepth === 8) return raw[rowOff + x]!
  const perByte = 8 / bitDepth
  const byte = raw[rowOff + Math.floor(x / perByte)]!
  const shift = 8 - bitDepth * ((x % perByte) + 1)
  return (byte >> shift) & ((1 << bitDepth) - 1)
}
