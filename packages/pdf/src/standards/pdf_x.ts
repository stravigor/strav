/**
 * PDF/X-4 conformance checks (spec §15.2). Returns the list of violations.
 *
 * Enforced here: an OutputIntent with a CMYK/Gray destination profile, and a
 * TrimBox or ArtBox on every page (MediaBox always exists). Embedded-and-
 * subsetted fonts and the `/ID` array are guaranteed by the library; the
 * no-Standard-14 rule throws `UnsupportedFontError` earlier.
 */

import type { ConformanceContext } from './context.ts'

export function validatePdfX(ctx: ConformanceContext): string[] {
  const v: string[] = []

  if (!ctx.outputIntent.present) {
    v.push('PDF/X-4 requires an OutputIntent — call setOutputIntent()')
  } else {
    const cs = ctx.outputIntent.profileColorSpace
    if (cs !== 'CMYK' && cs !== 'GRAY') {
      v.push(`PDF/X-4 output intent profile must be CMYK or Gray (got ${cs ?? 'unknown'})`)
    }
  }

  ctx.pages.forEach((p, i) => {
    if (!p.hasTrimOrArt) {
      v.push(`PDF/X-4 page ${i + 1} requires a TrimBox or ArtBox (MediaBox alone is not enough)`)
    }
  })

  return v
}
