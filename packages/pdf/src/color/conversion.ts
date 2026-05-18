/**
 * Naïve device-space color conversions (spec §9.4).
 *
 * ⚠️ Preview only — NOT color-accurate. Callers needing accurate conversion
 * must use a real CMM externally and pass pre-converted values.
 */

import type { Color } from './color.ts'
import { gray, rgb, cmyk } from './color.ts'

/** Rec.601 luma. */
export function rgbToGray(r: number, g: number, b: number): Color {
  return gray(0.299 * r + 0.587 * g + 0.114 * b)
}

/** Simple CMYK → RGB. */
export function cmykToRgb(c: number, m: number, y: number, k: number): Color {
  return rgb((1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k))
}

/** Simple RGB → CMYK with black generation. */
export function rgbToCmyk(r: number, g: number, b: number): Color {
  const k = 1 - Math.max(r, g, b)
  if (k >= 1) return cmyk(0, 0, 0, 1)
  return cmyk((1 - r - k) / (1 - k), (1 - g - k) / (1 - k), (1 - b - k) / (1 - k), k)
}
