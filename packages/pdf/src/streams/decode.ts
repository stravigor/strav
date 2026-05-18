/**
 * Stream filter dispatch (read side, spec §7.4). Resolves a stream's
 * `/Filter` + `/DecodeParms` (name or parallel arrays, possibly indirect) and
 * applies each decode filter in order. Image filters (DCT/JPX/CCITT/JBIG2) are
 * terminal and returned unchanged — text extraction never needs their pixels.
 */

import type { PdfDictionary, PdfObject } from '../objects/types.ts'
import { isArr, isDict, isName, isNum } from '../objects/types.ts'
import { flateDecode, type PredictorParams } from './flate.ts'
import { lzwDecode } from './lzw.ts'
import { ascii85Decode } from './ascii85.ts'
import { asciiHexDecode } from './ascii_hex.ts'
import { runLengthDecode } from './runlength.ts'

/** Filters whose output is binary image data, not byte-stream content. */
const IMAGE_FILTERS = new Set(['DCTDecode', 'JPXDecode', 'CCITTFaxDecode', 'JBIG2Decode'])

export type Resolve = (o: PdfObject | undefined) => PdfObject | undefined

function dictGet(d: PdfDictionary, key: string, resolve: Resolve): PdfObject | undefined {
  return resolve(d.entries.get(key))
}

function asList(o: PdfObject | undefined, resolve: Resolve): (PdfObject | undefined)[] {
  if (!o) return []
  if (isArr(o)) return o.items.map((x) => resolve(x))
  return [o]
}

function predictorParams(o: PdfObject | undefined, resolve: Resolve): PredictorParams &
  { earlyChange?: number } {
  if (!o || !isDict(o)) return {}
  const n = (k: string): number | undefined => {
    const v = resolve(o.entries.get(k))
    return v && isNum(v) ? v.value : undefined
  }
  return {
    predictor: n('Predictor'),
    colors: n('Colors'),
    bitsPerComponent: n('BitsPerComponent'),
    columns: n('Columns'),
    earlyChange: n('EarlyChange'),
  }
}

/**
 * Decode the on-disk bytes of a stream into its logical content. Returns the
 * (possibly partially) decoded bytes; stops at the first image filter.
 */
export function decodeStream(
  dict: PdfDictionary,
  data: Uint8Array,
  resolve: Resolve = (o) => o,
): Uint8Array {
  const filters = asList(
    dictGet(dict, 'Filter', resolve) ?? dictGet(dict, 'F', resolve),
    resolve,
  )
  if (filters.length === 0) return data

  const parmsRaw = dictGet(dict, 'DecodeParms', resolve) ?? dictGet(dict, 'DP', resolve)
  const parmsList = asList(parmsRaw, resolve)

  let out = data
  for (let i = 0; i < filters.length; i++) {
    const f = filters[i]
    if (!f || !isName(f)) continue
    const parms = predictorParams(parmsList[i], resolve)
    switch (f.value) {
      case 'FlateDecode':
      case 'Fl':
        out = flateDecode(out, parms)
        break
      case 'LZWDecode':
      case 'LZW':
        out = lzwDecode(out, parms)
        break
      case 'ASCII85Decode':
      case 'A85':
        out = ascii85Decode(out)
        break
      case 'ASCIIHexDecode':
      case 'AHx':
        out = asciiHexDecode(out)
        break
      case 'RunLengthDecode':
      case 'RL':
        out = runLengthDecode(out)
        break
      default:
        if (IMAGE_FILTERS.has(f.value)) return out // terminal: leave encoded
        // Unknown filter — return what we have rather than corrupt further.
        return out
    }
  }
  return out
}
