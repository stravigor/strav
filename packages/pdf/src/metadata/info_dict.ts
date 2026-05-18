/**
 * The legacy Info dictionary (spec §14.1). Kept for old readers and the
 * trailer `/Info`; XMP (metadata/xmp.ts) is the authoritative source and is
 * built from the same values so the two stay in sync.
 */

import { dict } from '../objects/types.ts'
import type { PdfDictionary, PdfObject } from '../objects/types.ts'
import { textString, dateString } from '../objects/string.ts'
import type { DocumentInfo } from '../document/types.ts'

export function buildInfoDict(
  info: DocumentInfo,
  creationDate: Date,
  producer: string
): PdfDictionary {
  const d = dateString(creationDate)
  const entries: Record<string, PdfObject> = {}
  if (info.title) entries.Title = textString(info.title)
  if (info.author) entries.Author = textString(info.author)
  if (info.subject) entries.Subject = textString(info.subject)
  if (info.keywords) entries.Keywords = textString(info.keywords)
  if (info.creator) entries.Creator = textString(info.creator)
  entries.Producer = textString(producer)
  entries.CreationDate = d
  entries.ModDate = d
  return dict(entries)
}
