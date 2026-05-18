/**
 * Color values and factories (spec §9).
 *
 * M1–M3 ship the three device color spaces. CIE-based, ICCBased, Indexed,
 * Separation, DeviceN and Pattern arrive in M9 — the union is designed to grow
 * without breaking existing callers.
 */

import { PdfGenError } from '../util/errors.ts'

/** Device color space names available in this milestone. */
export type ColorSpace = 'DeviceGray' | 'DeviceRGB' | 'DeviceCMYK'

export type Color =
  | { space: 'DeviceGray'; g: number }
  | { space: 'DeviceRGB'; r: number; g: number; b: number }
  | { space: 'DeviceCMYK'; c: number; m: number; y: number; k: number }

function unit(name: string, v: number): number {
  if (!Number.isFinite(v) || v < 0 || v > 1) {
    throw new PdfGenError(
      'PDF_INVALID_COLOR',
      `${name} component must be in [0, 1], got ${v}`
    )
  }
  return v
}

/** DeviceGray. `g` in [0,1] (0 = black, 1 = white). */
export function gray(g: number): Color {
  return { space: 'DeviceGray', g: unit('Gray', g) }
}

/** DeviceRGB. Components in [0,1]. */
export function rgb(r: number, g: number, b: number): Color {
  return {
    space: 'DeviceRGB',
    r: unit('R', r),
    g: unit('G', g),
    b: unit('B', b),
  }
}

/** DeviceCMYK. Components in [0,1]. */
export function cmyk(c: number, m: number, y: number, k: number): Color {
  return {
    space: 'DeviceCMYK',
    c: unit('C', c),
    m: unit('M', m),
    y: unit('Y', y),
    k: unit('K', k),
  }
}

/** Namespace form of the factories (spec §16 exports `Color` as a value). */
export const Color = { gray, rgb, cmyk } as const
