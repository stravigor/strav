/**
 * `PdfImage` (spec §11, §16). The public image handle.
 *
 * - `PdfImage.fromJpeg(bytes)` — embedded verbatim as a `/DCTDecode` XObject.
 * - `PdfImage.fromPng(bytes)`  — decoded and re-emitted as a `/FlateDecode`
 *   XObject; alpha becomes an `/SMask`, a palette an `/Indexed` color space.
 *
 * Like {@link PdfFont}, an image registers itself into the object table via
 * `register(table)` and returns the XObject reference for the page resources.
 */

import type { IndirectRef, PdfObject } from '../objects/types.ts'
import { arr, name, num } from '../objects/types.ts'
import { hexBytes } from '../objects/string.ts'
import type { ObjectTable } from '../document/object_table.ts'
import { makeStream } from '../streams/stream.ts'
import { parseJpeg } from './jpeg.ts'
import { parsePng, type PngColorSpace } from './png.ts'
import { buildSMask } from './smask.ts'

export abstract class PdfImage {
  /** Pixel dimensions (independent of the drawn size). */
  abstract readonly width: number
  abstract readonly height: number

  /** Add the image (and any soft mask) to the table; return the XObject ref. */
  abstract register(table: ObjectTable): IndirectRef

  /** A baseline/progressive JPEG, embedded without re-encoding. */
  static fromJpeg(bytes: Uint8Array): PdfImage {
    return new JpegImage(bytes)
  }

  /** A non-interlaced PNG, decoded and re-encoded as FlateDecode. */
  static fromPng(bytes: Uint8Array): PdfImage {
    return new PngImage(bytes)
  }
}

function deviceColorSpace(components: 1 | 3 | 4): PdfObject {
  return name(components === 1 ? 'DeviceGray' : components === 3 ? 'DeviceRGB' : 'DeviceCMYK')
}

class JpegImage extends PdfImage {
  readonly width: number
  readonly height: number
  private readonly info: ReturnType<typeof parseJpeg>

  constructor(bytes: Uint8Array) {
    super()
    this.info = parseJpeg(bytes)
    this.width = this.info.width
    this.height = this.info.height
  }

  register(table: ObjectTable): IndirectRef {
    const extra: Record<string, PdfObject> = {
      Type: name('XObject'),
      Subtype: name('Image'),
      Width: num(this.info.width),
      Height: num(this.info.height),
      ColorSpace: deviceColorSpace(this.info.components),
      BitsPerComponent: num(8),
      Filter: name('DCTDecode'),
    }
    // Photoshop CMYK JPEGs store inverted samples (Adobe APP14).
    if (this.info.adobeInverted) {
      extra.Decode = arr([1, 0, 1, 0, 1, 0, 1, 0].map(num))
    }
    // filter:'none' → bytes embedded verbatim; /Filter set above.
    return table.add(makeStream(this.info.data, { filter: 'none', extra }))
  }
}

function pngColorSpaceObject(cs: PngColorSpace): PdfObject {
  if (cs.kind === 'Indexed') {
    return arr([name('Indexed'), name('DeviceRGB'), num(cs.hival), hexBytes(cs.palette)])
  }
  return name(cs.kind)
}

class PngImage extends PdfImage {
  readonly width: number
  readonly height: number
  private readonly png: ReturnType<typeof parsePng>

  constructor(bytes: Uint8Array) {
    super()
    this.png = parsePng(bytes)
    this.width = this.png.width
    this.height = this.png.height
  }

  register(table: ObjectTable): IndirectRef {
    let smaskRef: IndirectRef | undefined
    if (this.png.alpha) {
      smaskRef = table.add(buildSMask(this.png.alpha, this.png.width, this.png.height))
    }
    const extra: Record<string, PdfObject> = {
      Type: name('XObject'),
      Subtype: name('Image'),
      Width: num(this.png.width),
      Height: num(this.png.height),
      ColorSpace: pngColorSpaceObject(this.png.colorSpace),
      BitsPerComponent: num(this.png.bitsPerComponent),
    }
    if (smaskRef) extra.SMask = smaskRef
    if (this.png.colorKey) extra.Mask = arr(this.png.colorKey.map(num))
    return table.add(makeStream(this.png.samples, { filter: 'FlateDecode', extra }))
  }
}
