/**
 * Separation color space (spec §9.5) — a single spot colorant with an
 * alternate space and a tint transform.
 *
 * The high-level helper emits a Type 2 (exponential) function interpolating
 * between the alternate's zero color at tint 0 and the supplied full-strength
 * color at tint 1 (`N = 1`, linear). Type 4 PostScript tint transforms are
 * available via {@link deviceN} for advanced callers.
 */

import { arr, dict, name, num } from '../objects/types.ts'
import type { PdfObject } from '../objects/types.ts'
import { ascii } from '../util/ascii.ts'
import type { ObjectTable } from '../document/object_table.ts'
import type { ManagedColorSpace } from './space.ts'
import { managedColor } from './space.ts'
import type { Color, DeviceColor } from './color.ts'
import { deviceComponents, deviceSpaceName } from './color.ts'

class SeparationColorSpace implements ManagedColorSpace {
  readonly id: string
  readonly components = 1
  private readonly altName: string
  private readonly c1: number[]

  constructor(
    private readonly colorant: string,
    full: DeviceColor,
    private readonly tag: number
  ) {
    this.altName = deviceSpaceName(full)
    this.c1 = deviceComponents(full)
    this.id = `sep:${colorant}:${tag}`
  }

  build(table: ObjectTable): PdfObject {
    const c0 = this.c1.map(() => 0)
    const tintFn = table.add(
      dict({
        FunctionType: num(2),
        Domain: arr([num(0), num(1)]),
        C0: arr(c0.map(num)),
        C1: arr(this.c1.map(num)),
        N: num(1),
      })
    )
    return arr([
      name('Separation'),
      name(this.colorant),
      name(this.altName),
      tintFn,
    ])
  }

  /** A color at tint `t` in [0,1] (0 = no ink, 1 = full strength). */
  tint(t: number): Color {
    return managedColor(this, [t])
  }
}

let sepCounter = 0

/**
 * A Separation (spot) color space. `full` is the colour the colorant prints
 * at 100% tint, given in a device space (usually CMYK).
 *
 * ```ts
 * const pantone = separation('PANTONE 185 C', cmyk(0, 0.91, 0.76, 0))
 * c.setFillColor(pantone.tint(0.6))
 * ```
 */
export function separation(colorant: string, full: DeviceColor): SeparationColorSpace {
  return new SeparationColorSpace(colorant, full, sepCounter++)
}

export type { SeparationColorSpace }

/** A PostScript-calculator (Type 4) function stream, for DeviceN/advanced use. */
export function type4Function(
  domain: number[],
  range: number[],
  postscript: string
): (table: ObjectTable) => PdfObject {
  return table =>
    table.add({
      kind: 'stream',
      dict: dict({
        FunctionType: num(4),
        Domain: arr(domain.map(num)),
        Range: arr(range.map(num)),
      }),
      data: ascii(postscript),
    })
}
