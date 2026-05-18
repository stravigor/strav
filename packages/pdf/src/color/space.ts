/**
 * Managed (non-device) color spaces (spec §9.1).
 *
 * DeviceGray/RGB/CMYK use the shortcut operators and need no resources. The
 * remaining spaces — ICCBased, Separation, DeviceN, CalGray/CalRGB/Lab — are
 * objects (a name or array, sometimes with indirect children) registered in
 * the page `/Resources /ColorSpace` map and selected with `cs`/`CS` + `scn`.
 *
 * Each implementation builds its PDF object via `build(table)` and produces
 * tinted {@link Color} values via `color(...)`.
 */

import { PdfGenError } from '../util/errors.ts'
import type { ObjectTable } from '../document/object_table.ts'
import type { PdfObject } from '../objects/types.ts'

export interface ManagedColorSpace {
  /** Stable identity for resource deduplication. */
  readonly id: string
  /** Number of colour components (operands for `scn`/`SCN`). */
  readonly components: number
  /** Build the color-space object, adding any child objects to the table. */
  build(table: ObjectTable): PdfObject
}

/** A color value in a managed color space (selected via `cs`/`CS`). */
export type ManagedColor = {
  space: 'Managed'
  cs: ManagedColorSpace
  comps: number[]
}

/** Validate + build a {@link ManagedColor} for a managed space. */
export function managedColor(cs: ManagedColorSpace, comps: number[]): ManagedColor {
  if (comps.length !== cs.components) {
    throw new PdfGenError(
      'PDF_INVALID_COLOR',
      `${cs.id} expects ${cs.components} component(s), got ${comps.length}`
    )
  }
  for (const v of comps) {
    if (!Number.isFinite(v)) {
      throw new PdfGenError('PDF_INVALID_COLOR', `Non-finite color component in ${cs.id}`)
    }
  }
  return { space: 'Managed', cs, comps }
}
