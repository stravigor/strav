/**
 * Unit helpers (spec §6.4). The public API uses points (1 pt = 1/72 inch),
 * matching PDF user space. These convert from physical units.
 */

/** Points → points (identity; provided for symmetry and readability). */
export function pt(value: number): number {
  return value
}

/** Inches → points. 1 inch = 72 pt exactly. */
export function inch(value: number): number {
  return value * 72
}

/** Millimetres → points. 1 mm = 72 / 25.4 pt. */
export function mm(value: number): number {
  return (value * 72) / 25.4
}

/** Centimetres → points. */
export function cm(value: number): number {
  return mm(value * 10)
}
