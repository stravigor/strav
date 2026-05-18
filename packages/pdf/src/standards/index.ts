/**
 * Conformance dispatch (spec §15). `setConformance(...)` opts in; validation
 * runs at `save()` and a non-empty result becomes a `ConformanceError`.
 */

import type { ConformanceLevel } from '../document/types.ts'
import type { ConformanceContext } from './context.ts'
import { validatePdfA } from './pdf_a.ts'
import { validatePdfX } from './pdf_x.ts'

export type { ConformanceContext } from './context.ts'
export { validatePdfA } from './pdf_a.ts'
export { validatePdfX } from './pdf_x.ts'

/** Returns all conformance violations for `level` (empty = conforms). */
export function validateConformance(
  level: ConformanceLevel,
  ctx: ConformanceContext
): string[] {
  if (level === 'PDF/A-2b') return validatePdfA(ctx)
  if (level === 'PDF/X-4') return validatePdfX(ctx)
  return []
}
