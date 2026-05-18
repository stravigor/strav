/**
 * The PDF object model (spec §5). The seven PDF object types plus the
 * indirect reference, modelled as a discriminated union on `kind`.
 */

export type PdfObject =
  | PdfNull
  | PdfBoolean
  | PdfNumber
  | PdfString
  | PdfName
  | PdfArray
  | PdfDictionary
  | PdfStream
  | IndirectRef

export type PdfNull = { kind: 'null' }
export type PdfBoolean = { kind: 'bool'; value: boolean }
/** Integer or real. Serialization decides formatting (objects/number.ts). */
export type PdfNumber = { kind: 'num'; value: number }
export type PdfString = {
  kind: 'str'
  /** Raw bytes — already in the final on-disk byte sequence. */
  value: Uint8Array
  /** Serialization hint: literal `( )` or hex `< >`. */
  encoding: 'literal' | 'hex'
}
/** Unescaped name value (no leading slash, decoded #XX). */
export type PdfName = { kind: 'name'; value: string }
export type PdfArray = { kind: 'arr'; items: PdfObject[] }
export type PdfDictionary = { kind: 'dict'; entries: Map<string, PdfObject> }
export type PdfStream = {
  kind: 'stream'
  /** Includes /Length and /Filter. */
  dict: PdfDictionary
  /** Already-filtered bytes (final on-disk data). */
  data: Uint8Array
}
export type IndirectRef = { kind: 'ref'; num: number; gen: number }

// ── Constructors ──────────────────────────────────────────────────────────

export const NULL: PdfNull = { kind: 'null' }

export function bool(value: boolean): PdfBoolean {
  return { kind: 'bool', value }
}

export function num(value: number): PdfNumber {
  return { kind: 'num', value }
}

export function name(value: string): PdfName {
  return { kind: 'name', value }
}

export function arr(items: PdfObject[] = []): PdfArray {
  return { kind: 'arr', items }
}

/** Build a dictionary from an object literal (insertion order preserved). */
export function dict(entries: Record<string, PdfObject> = {}): PdfDictionary {
  return { kind: 'dict', entries: new Map(Object.entries(entries)) }
}

export function ref(num: number, gen = 0): IndirectRef {
  return { kind: 'ref', num, gen }
}

// ── Type guards ───────────────────────────────────────────────────────────

export const isNull = (o: PdfObject): o is PdfNull => o.kind === 'null'
export const isBool = (o: PdfObject): o is PdfBoolean => o.kind === 'bool'
export const isNum = (o: PdfObject): o is PdfNumber => o.kind === 'num'
export const isStr = (o: PdfObject): o is PdfString => o.kind === 'str'
export const isName = (o: PdfObject): o is PdfName => o.kind === 'name'
export const isArr = (o: PdfObject): o is PdfArray => o.kind === 'arr'
export const isDict = (o: PdfObject): o is PdfDictionary => o.kind === 'dict'
export const isStream = (o: PdfObject): o is PdfStream => o.kind === 'stream'
export const isRef = (o: PdfObject): o is IndirectRef => o.kind === 'ref'

/** Set a dictionary entry, returning the dictionary for chaining. */
export function dictSet(d: PdfDictionary, key: string, value: PdfObject): PdfDictionary {
  d.entries.set(key, value)
  return d
}
