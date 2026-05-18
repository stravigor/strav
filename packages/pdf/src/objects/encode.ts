/**
 * Object → bytes (spec §5.1).
 *
 * Pure and deterministic: the same {@link PdfObject} always encodes to the
 * same bytes. Dictionary keys are emitted in `Map` insertion order.
 *
 * This encodes the *value* of an object. Wrapping a value in `N G obj … endobj`
 * is the document serializer's job (document/xref.ts).
 */

import { ascii, concatBytes, SPACE, LF } from '../util/ascii.ts'
import { PdfGenError } from '../util/errors.ts'
import type { PdfObject, PdfDictionary } from './types.ts'
import { formatNumber } from './number.ts'
import { encodeName } from './name.ts'
import { encodeLiteral, encodeHex } from './string.ts'
import { refToken } from './indirect_ref.ts'

const TRUE = ascii('true')
const FALSE = ascii('false')
const NULL = ascii('null')
const DICT_OPEN = ascii('<<')
const DICT_CLOSE = ascii('>>')
const STREAM_KW = ascii('stream\n')
const ENDSTREAM_KW = ascii('\nendstream')

export function encodeObject(o: PdfObject): Uint8Array {
  switch (o.kind) {
    case 'null':
      return NULL
    case 'bool':
      return o.value ? TRUE : FALSE
    case 'num':
      return ascii(formatNumber(o.value))
    case 'str':
      return o.encoding === 'hex' ? encodeHex(o.value) : encodeLiteral(o.value)
    case 'name':
      return encodeName(o.value)
    case 'ref':
      return ascii(refToken(o))
    case 'arr': {
      const parts: Uint8Array[] = [Uint8Array.of(0x5b)] // [
      for (let i = 0; i < o.items.length; i++) {
        if (i > 0) parts.push(Uint8Array.of(SPACE))
        parts.push(encodeObject(o.items[i]!))
      }
      parts.push(Uint8Array.of(0x5d)) // ]
      return concatBytes(parts)
    }
    case 'dict':
      return encodeDict(o)
    case 'stream': {
      // /Length must equal the post-filter data length (spec §5.1).
      o.dict.entries.set('Length', { kind: 'num', value: o.data.length })
      return concatBytes([
        encodeDict(o.dict),
        Uint8Array.of(LF),
        STREAM_KW,
        o.data,
        ENDSTREAM_KW,
      ])
    }
    default: {
      const _exhaustive: never = o
      throw new PdfGenError('PDF_INVALID_OBJECT', `Unknown object: ${_exhaustive}`)
    }
  }
}

function encodeDict(d: PdfDictionary): Uint8Array {
  const parts: Uint8Array[] = [DICT_OPEN]
  for (const [key, value] of d.entries) {
    parts.push(encodeName(key), Uint8Array.of(SPACE), encodeObject(value), Uint8Array.of(SPACE))
  }
  parts.push(DICT_CLOSE)
  return concatBytes(parts)
}
