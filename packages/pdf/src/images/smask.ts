/**
 * Soft mask for image alpha (spec §11.2). An 8-bit alpha plane becomes a
 * standalone DeviceGray image XObject referenced from the parent image's
 * `/SMask` entry.
 */

import { name, num } from '../objects/types.ts'
import type { PdfStream } from '../objects/types.ts'
import { makeStream } from '../streams/stream.ts'

/** Build the soft-mask image XObject stream from an alpha plane. */
export function buildSMask(alpha: Uint8Array, width: number, height: number): PdfStream {
  return makeStream(alpha, {
    filter: 'FlateDecode',
    extra: {
      Type: name('XObject'),
      Subtype: name('Image'),
      Width: num(width),
      Height: num(height),
      ColorSpace: name('DeviceGray'),
      BitsPerComponent: num(8),
    },
  })
}
