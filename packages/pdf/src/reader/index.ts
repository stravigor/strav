/**
 * Read side (M13) sub-module barrel. The headline API plus lower-level pieces
 * for advanced callers, mirroring how `document/index.ts` exposes internals.
 */

export { extractText, PdfReader } from './extract.ts'
export type {
  ExtractOptions,
  ExtractResult,
  ExtractedPage,
  PdfInfo,
} from './extract.ts'

export { PdfReaderDocument } from './document.ts'
export { Lexer } from './lexer.ts'
export { ObjectParser, parseObjectFrom } from './object_parser.ts'
export { parseXref, bruteForceXref, findStartXref } from './xref.ts'
export type { XrefTable, XrefEntry } from './xref.ts'
export { parseObjStm } from './objstm.ts'
export { parseCMap, CMap } from './cmap_parser.ts'
export { buildCharMap } from './fonts.ts'
export type { CharMap, DecodedGlyph } from './fonts.ts'
export { interpretText } from './text_interpreter.ts'
export { runsToText } from './layout.ts'
export type { Run } from './layout.ts'
export { buildDecryptor } from './decrypt.ts'
export type { Decryptor } from './decrypt.ts'
