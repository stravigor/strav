/**
 * ICC profile reading + embedding (spec §9.2).
 *
 * We do **no** color transforms. The profile is an opaque blob embedded for
 * the consumer (RIP, Acrobat). We parse only the 128-byte header to learn the
 * data color space (→ component count) and validate the `acsp` signature.
 */

import { PdfGenError } from '../util/errors.ts'
import { arr, name, num } from '../objects/types.ts'
import type { PdfObject } from '../objects/types.ts'
import type { ObjectTable } from '../document/object_table.ts'
import { makeStream } from '../streams/stream.ts'
import type { ManagedColorSpace } from './space.ts'
import { managedColor } from './space.ts'
import type { Color } from './color.ts'

export type IccColorSpace = 'GRAY' | 'RGB' | 'CMYK' | 'Lab'

export interface IccProfile {
  /** Data color space (from header offset 16). */
  colorSpace: IccColorSpace
  /** Component count: GRAY 1, RGB/Lab 3, CMYK 4. */
  components: 1 | 3 | 4
  /** Profile/device class fourcc (offset 12), e.g. `prtr`, `mntr`. */
  profileClass: string
  /** Profile connection space (offset 20), e.g. `XYZ ` or `Lab `. */
  pcs: string
  bytes: Uint8Array
}

function fourcc(b: Uint8Array, o: number): string {
  return String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!)
}

export function parseIccProfile(bytes: Uint8Array): IccProfile {
  if (bytes.length < 128) {
    throw new PdfGenError('PDF_INVALID_COLOR', 'ICC profile too short (need ≥128-byte header)')
  }
  if (fourcc(bytes, 36) !== 'acsp') {
    throw new PdfGenError('PDF_INVALID_COLOR', "Not an ICC profile (missing 'acsp' signature)")
  }
  const sig = fourcc(bytes, 16)
  const map: Record<string, { cs: IccColorSpace; n: 1 | 3 | 4 }> = {
    'GRAY': { cs: 'GRAY', n: 1 },
    'RGB ': { cs: 'RGB', n: 3 },
    'CMYK': { cs: 'CMYK', n: 4 },
    'Lab ': { cs: 'Lab', n: 3 },
  }
  const m = map[sig]
  if (!m) {
    throw new PdfGenError('PDF_INVALID_COLOR', `Unsupported ICC data color space '${sig}'`)
  }
  return {
    colorSpace: m.cs,
    components: m.n,
    profileClass: fourcc(bytes, 12),
    pcs: fourcc(bytes, 20),
    bytes,
  }
}

function altName(components: 1 | 3 | 4): string {
  return components === 1 ? 'DeviceGray' : components === 3 ? 'DeviceRGB' : 'DeviceCMYK'
}

class IccBasedColorSpace implements ManagedColorSpace {
  readonly id: string
  readonly components: number

  constructor(
    private readonly profile: IccProfile,
    private readonly tag: number
  ) {
    this.components = profile.components
    this.id = `icc:${profile.colorSpace}:${tag}`
  }

  build(table: ObjectTable): PdfObject {
    const stream = makeStream(this.profile.bytes, {
      filter: 'FlateDecode',
      extra: {
        N: num(this.profile.components),
        Alternate: name(altName(this.profile.components)),
      },
    })
    return arr([name('ICCBased'), table.add(stream)])
  }

  /** A color in this profile's space (components in [0,1]). */
  color(...comps: number[]): Color {
    return managedColor(this, comps)
  }
}

let iccCounter = 0

/** An ICCBased color space from raw ICC profile bytes (`.icc`/`.icm`). */
export function iccBased(profileBytes: Uint8Array): IccBasedColorSpace {
  return new IccBasedColorSpace(parseIccProfile(profileBytes), iccCounter++)
}

export type { IccBasedColorSpace }
