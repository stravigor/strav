/**
 * The document catalog (`/Type /Catalog`, spec §6.1). v1 populates the
 * required `/Pages` and `/Version` entries. `/Metadata`, `/OutputIntents`,
 * etc. are added by later milestones (M9/M11).
 */

import type { IndirectRef } from '../objects/types.ts'
import { dict, name } from '../objects/types.ts'

export function buildCatalog(pagesRoot: IndirectRef) {
  return dict({
    Type: name('Catalog'),
    Version: name('1.7'),
    Pages: pagesRoot,
  })
}
