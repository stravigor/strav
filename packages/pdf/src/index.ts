/**
 * `@strav/pdf` — low-level, zero-dependency PDF generation (write side).
 *
 * This effort delivers spec milestones 1–3: object model & serialization,
 * pages + content streams + device color, and stream filters. Fonts, images,
 * color management, transparency and conformance modes are later milestones.
 */

export { PdfDocument } from './document/pdf_document.ts'
export { Page } from './document/page.ts'
export type {
  PageSize,
  Rect,
  ConformanceLevel,
  DocumentInfo,
  CreateOptions,
  AddPageOptions,
} from './document/types.ts'

export { ContentStream } from './content/content_stream.ts'
export type { TextObject, RunPart } from './content/text_object.ts'

export { PdfFont } from './fonts/font.ts'
export type { StandardFontName, TrueTypeOptions } from './fonts/font.ts'

export { Color, rgb, cmyk, gray } from './color/color.ts'
export type { Color as ColorValue, ColorSpace } from './color/color.ts'
export { rgbToGray, cmykToRgb, rgbToCmyk } from './color/conversion.ts'

export { mm, cm, inch, pt } from './util/units.ts'

export {
  PdfGenError,
  ConformanceError,
  UnsupportedFontError,
  InvalidImageError,
} from './util/errors.ts'
export type { PdfGenErrorCode } from './util/errors.ts'
