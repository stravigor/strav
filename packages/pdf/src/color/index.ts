export type { ColorSpace } from './color.ts'
// A named re-export carries both the type and value meanings of `Color`.
export { Color, gray, rgb, cmyk } from './color.ts'
export { rgbToGray, cmykToRgb, rgbToCmyk } from './conversion.ts'
export { fillColorOp, strokeColorOp } from './device.ts'
