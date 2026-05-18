/** Public value types for the document layer (spec §6). */

/** A page size in PDF points. */
export interface PageSize {
  widthPt: number
  heightPt: number
}

/** A rectangle in PDF points, origin bottom-left. */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** Conformance target. `null` = plain PDF 1.7. Enforced in M11. */
export type ConformanceLevel = 'PDF/A-2b' | 'PDF/X-4' | null

/** Document metadata written to the Info dictionary (spec §14.1). */
export interface DocumentInfo {
  title?: string
  author?: string
  subject?: string
  keywords?: string
  creator?: string
}

export interface CreateOptions {
  info?: DocumentInfo
  /** Conformance target (validated at save in M11; accepted now). */
  conformance?: ConformanceLevel
  /**
   * Fixed creation date for deterministic output (spec §16.3). Defaults to
   * `new Date()` at save time.
   */
  creationDate?: Date
  /**
   * Fixed 16-byte document ID for deterministic output. Hex string of 32
   * chars, or raw bytes. Defaults to a content-derived hash.
   */
  documentId?: string | Uint8Array
}

export interface AddPageOptions {
  size: PageSize
  rotation?: 0 | 90 | 180 | 270
}

/** Output intent (spec §9.3) — embeds a destination ICC profile. */
export interface OutputIntentConfig {
  /** `GTS_PDFX` (print) or `GTS_PDFA1` (archival). */
  subtype: 'GTS_PDFX' | 'GTS_PDFA1' | string
  outputConditionIdentifier: string
  outputCondition?: string
  registryName?: string
  info?: string
  /** Raw ICC profile bytes (CMYK or Gray for PDF/X). */
  destOutputProfile: Uint8Array
}

/** Convert a {@link Rect} to a PDF box array `[llx lly urx ury]`. */
export function rectToBox(r: Rect): [number, number, number, number] {
  return [r.x, r.y, r.x + r.w, r.y + r.h]
}
