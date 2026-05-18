/** Inputs to the conformance validators (gathered by PdfDocument at save). */
export interface ConformanceContext {
  /** One entry per page; whether it has a TrimBox or ArtBox set. */
  pages: { hasTrimOrArt: boolean }[]
  outputIntent: {
    present: boolean
    /** ICC data color space of the destination profile, if present. */
    profileColorSpace?: 'GRAY' | 'RGB' | 'CMYK' | 'Lab'
  }
}
