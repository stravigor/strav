/**
 * Compressed object streams (`/Type /ObjStm`, spec §7.5.7). Header is `N`
 * pairs `(objNum, byteOffset)`; the objects themselves start at `/First`.
 * Objects inside an ObjStm may not be streams and may not be ObjStm
 * themselves — the document layer enforces no ObjStm-in-ObjStm recursion.
 */

import { type PdfObject, isNum } from '../objects/types.ts'
import { PdfParseError } from '../util/errors.ts'
import { Lexer } from './lexer.ts'
import { ObjectParser } from './object_parser.ts'

export interface ObjStmContents {
  /** objNum → parsed value. */
  objects: Map<number, PdfObject>
}

export function parseObjStm(dict: { entries: Map<string, PdfObject> }, data: Uint8Array): ObjStmContents {
  const nObj = dict.entries.get('N')
  const firstObj = dict.entries.get('First')
  if (!nObj || !isNum(nObj) || !firstObj || !isNum(firstObj)) {
    throw new PdfParseError('ObjStm missing /N or /First')
  }
  const n = nObj.value
  const first = firstObj.value

  const headerLex = new Lexer(data, 0)
  const table: { num: number; off: number }[] = []
  for (let i = 0; i < n; i++) {
    const a = headerLex.next()
    const b = headerLex.next()
    if (a.type !== 'num' || b.type !== 'num') {
      throw new PdfParseError('Malformed ObjStm header')
    }
    table.push({ num: a.value, off: b.value })
  }

  const objects = new Map<number, PdfObject>()
  for (const { num, off } of table) {
    const parser = new ObjectParser(new Lexer(data, first + off))
    objects.set(num, parser.parseObject())
  }
  return { objects }
}
