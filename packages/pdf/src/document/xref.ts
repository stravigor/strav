/**
 * Serialize pass: file header, body, classic cross-reference table, and
 * trailer (spec §6.5). v1 emits a classic xref table only; cross-reference
 * streams are deferred to v1.1 (this module is the seam for that swap).
 */

import { ascii } from '../util/ascii.ts'
import type { ByteSink } from '../output/byte_sink.ts'
import type { IndirectRef } from '../objects/types.ts'
import { arr, dict, num } from '../objects/types.ts'
import { hexBytes } from '../objects/string.ts'
import { encodeObject } from '../objects/encode.ts'
import type { ObjectTable } from './object_table.ts'

// "%PDF-1.7\n" then a comment of four >=128 bytes so transfer tools treat the
// file as binary (ISO 32000-1 §7.5.2).
const HEADER = Uint8Array.from([
  0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x0a, // %PDF-1.7\n
  0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a, // %âãÏÓ\n
])

function pad10(n: number): string {
  return String(n).padStart(10, '0')
}

export interface SerializeInput {
  table: ObjectTable
  root: IndirectRef
  info: IndirectRef
  /** Permanent id and per-save id (each exactly 16 bytes). */
  id: [Uint8Array, Uint8Array]
  sink: ByteSink
}

export function serializeDocument(input: SerializeInput): void {
  const { table, root, info, id, sink } = input

  sink.write(HEADER)

  // Body. Offsets are recorded at the byte position of "N 0 obj".
  const offsets = new Map<number, number>()
  for (const [n, value] of table.entries()) {
    offsets.set(n, sink.length)
    sink.write(ascii(`${n} 0 obj\n`))
    sink.write(encodeObject(value))
    sink.write(ascii('\nendobj\n'))
  }

  const size = table.size // includes object 0
  const xrefOffset = sink.length

  // Classic xref table. Every entry line is exactly 20 bytes (incl. "\r\n").
  let xref = `xref\n0 ${size}\n0000000000 65535 f\r\n`
  for (let n = 1; n < size; n++) {
    xref += `${pad10(offsets.get(n)!)} 00000 n\r\n`
  }
  sink.write(ascii(xref))

  const trailer = dict({
    Size: num(size),
    Root: root,
    Info: info,
    ID: arr([hexBytes(id[0]), hexBytes(id[1])]),
  })
  sink.write(ascii('trailer\n'))
  sink.write(encodeObject(trailer))
  sink.write(ascii(`\nstartxref\n${xrefOffset}\n%%EOF\n`))
}
