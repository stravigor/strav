/**
 * JPEG (JFIF/EXIF) parsing (spec §11.1).
 *
 * JPEG image data is embedded **verbatim** with `/DCTDecode` — we never
 * re-encode. We only walk the marker segments to learn the dimensions,
 * component count and bit depth, and whether an Adobe APP14 marker is present
 * (Photoshop CMYK JPEGs store inverted samples → a `/Decode` inversion).
 */

import { InvalidImageError } from '../util/errors.ts'

export interface JpegInfo {
  width: number
  height: number
  /** 1 = Gray, 3 = RGB/YCbCr, 4 = CMYK/YCCK. */
  components: 1 | 3 | 4
  bitsPerComponent: number
  /** Adobe APP14 present — 4-component data is inverted (set `/Decode`). */
  adobeInverted: boolean
  /** The original JPEG bytes, embedded as-is. */
  data: Uint8Array
}

export function parseJpeg(data: Uint8Array): JpegInfo {
  if (data.length < 4 || data[0] !== 0xff || data[1] !== 0xd8) {
    throw new InvalidImageError('Not a JPEG (missing SOI marker)')
  }

  let hasAdobe = false
  let width = 0
  let height = 0
  let components: 1 | 3 | 4 = 3
  let precision = 8
  let sawSOF = false

  let i = 2
  while (i + 1 < data.length) {
    if (data[i] !== 0xff) {
      i++
      continue
    }
    let marker = data[i + 1]!
    // Skip fill bytes (0xFF padding).
    while (marker === 0xff && i + 2 < data.length) {
      i++
      marker = data[i + 1]!
    }
    i += 2
    // Standalone markers (no length): RSTn, SOI, EOI, TEM.
    if (marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      continue
    }
    if (i + 1 >= data.length) break
    const segLen = (data[i]! << 8) | data[i + 1]!
    const segStart = i + 2
    const segEnd = i + segLen

    if (marker === 0xee) {
      // APP14 "Adobe"
      if (
        segLen >= 7 &&
        data[segStart] === 0x41 && // 'A'
        data[segStart + 1] === 0x64 && // 'd'
        data[segStart + 2] === 0x6f // 'o'
      ) {
        hasAdobe = true
      }
    } else if (
      // SOF0..SOF15 except DHT(C4), DAC(CC), and the JPG marker (C8).
      marker >= 0xc0 &&
      marker <= 0xcf &&
      marker !== 0xc4 &&
      marker !== 0xc8 &&
      marker !== 0xcc
    ) {
      precision = data[segStart]!
      height = (data[segStart + 1]! << 8) | data[segStart + 2]!
      width = (data[segStart + 3]! << 8) | data[segStart + 4]!
      components = data[segStart + 5]! as 1 | 3 | 4
      sawSOF = true
    } else if (marker === 0xda) {
      break // SOS — entropy-coded data follows; stop scanning.
    }
    i = segEnd
  }

  if (!sawSOF) throw new InvalidImageError('JPEG has no Start-Of-Frame marker')
  if (precision !== 8) {
    throw new InvalidImageError(`Unsupported JPEG precision ${precision} (only 8-bit is supported)`)
  }
  if (components !== 1 && components !== 3 && components !== 4) {
    throw new InvalidImageError(`Unsupported JPEG component count ${components}`)
  }

  return {
    width,
    height,
    components,
    bitsPerComponent: 8,
    adobeInverted: components === 4 && hasAdobe,
    data,
  }
}
