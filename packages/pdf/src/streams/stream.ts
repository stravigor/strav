/**
 * Stream construction (spec §7). Filters are applied *here*, at construction
 * time: the resulting {@link PdfStream}'s `data` is always the final on-disk
 * bytes and `/Length` is its filtered length. The library never stores
 * unfiltered data alongside a filter chain.
 */

import type { PdfObject, PdfStream } from '../objects/types.ts'
import { dict, name, num } from '../objects/types.ts'
import { flateEncode } from './flate.ts'
import { ascii85Encode } from './ascii85.ts'
import { asciiHexEncode } from './ascii_hex.ts'

export type FilterName = 'FlateDecode' | 'ASCII85Decode' | 'ASCIIHexDecode'

/** Streams below this size aren't worth filtering (spec §7.3). */
export const MIN_FILTER_BYTES = 64

export interface MakeStreamOptions {
  /**
   * `'auto'` (default) FlateDecodes when worthwhile; `'none'` never filters;
   * or force a specific filter.
   */
  filter?: 'auto' | 'none' | FilterName
  /** Data is already compressed (e.g. JPEG/DCT) — never re-filter (§7.3). */
  alreadyCompressed?: boolean
  /** Extra dictionary entries (e.g. /Type, /Subtype for XObjects). */
  extra?: Record<string, PdfObject>
}

function applyFilter(data: Uint8Array, f: FilterName): Uint8Array {
  switch (f) {
    case 'FlateDecode':
      return flateEncode(data)
    case 'ASCII85Decode':
      return ascii85Encode(data)
    case 'ASCIIHexDecode':
      return asciiHexEncode(data)
  }
}

export function makeStream(raw: Uint8Array, opts: MakeStreamOptions = {}): PdfStream {
  const mode = opts.filter ?? 'auto'

  let filter: FilterName | null
  if (mode === 'none' || opts.alreadyCompressed) {
    filter = null
  } else if (mode === 'auto') {
    filter = raw.length >= MIN_FILTER_BYTES ? 'FlateDecode' : null
  } else {
    filter = mode
  }

  const data = filter ? applyFilter(raw, filter) : raw

  const entries: Record<string, PdfObject> = { ...opts.extra }
  if (filter) entries.Filter = name(filter)
  entries.Length = num(data.length)

  return { kind: 'stream', dict: dict(entries), data }
}

/** Page/Form content stream: auto-compressed (spec §7.1 default). */
export function makeContentStream(raw: Uint8Array): PdfStream {
  return makeStream(raw, { filter: 'auto' })
}
