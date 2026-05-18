/**
 * DeviceN color space (spec §9.5) — N named colorants mapped to an alternate
 * device space by a tint transform. The transform is an N→M Type 4 PostScript
 * function supplied by the caller (multi-input, so Type 2 doesn't apply).
 */

import { arr, name, num } from '../objects/types.ts'
import type { PdfObject } from '../objects/types.ts'
import type { ObjectTable } from '../document/object_table.ts'
import type { ManagedColorSpace } from './space.ts'
import { managedColor } from './space.ts'
import type { Color } from './color.ts'
import type { ColorSpace } from './color.ts'
import { type4Function } from './separation.ts'

class DeviceNColorSpace implements ManagedColorSpace {
  readonly id: string
  readonly components: number

  constructor(
    private readonly names: string[],
    private readonly alternate: ColorSpace,
    private readonly fn: (t: ObjectTable) => PdfObject,
    tag: number
  ) {
    this.components = names.length
    this.id = `devn:${names.join(',')}:${tag}`
  }

  build(table: ObjectTable): PdfObject {
    return arr([
      name('DeviceN'),
      arr(this.names.map(name)),
      name(this.alternate),
      this.fn(table),
    ])
  }

  /** A color with one tint per colorant (each in [0,1]). */
  color(...tints: number[]): Color {
    return managedColor(this, tints)
  }
}

let devnCounter = 0

/**
 * A DeviceN color space. `postscript` is a Type 4 calculator program mapping
 * the N colorant tints to the alternate space's components.
 *
 * ```ts
 * const duotone = deviceN(['Black', 'PANTONE 877 C'], 'DeviceCMYK',
 *   '{ exch dup 0 0 4 1 roll }')   // illustrative
 * ```
 */
export function deviceN(
  names: string[],
  alternate: ColorSpace,
  postscript: string
): DeviceNColorSpace {
  const altComps = alternate === 'DeviceGray' ? 1 : alternate === 'DeviceRGB' ? 3 : 4
  const domain: number[] = []
  for (let i = 0; i < names.length; i++) domain.push(0, 1)
  const range: number[] = []
  for (let i = 0; i < altComps; i++) range.push(0, 1)
  return new DeviceNColorSpace(
    names,
    alternate,
    type4Function(domain, range, postscript),
    devnCounter++
  )
}

export type { DeviceNColorSpace }
