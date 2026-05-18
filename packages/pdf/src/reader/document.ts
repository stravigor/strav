/**
 * Read-side document model. Owns the byte buffer, the merged xref table and
 * the (optional) decryptor; resolves indirect objects with a cache and a
 * cycle guard; materialises compressed object streams lazily; and walks the
 * page tree with attribute inheritance (spec §7.7).
 */

import {
  type PdfObject,
  type PdfDictionary,
  type PdfStream,
  isRef,
  isDict,
  isStream,
  isArr,
  isName,
  isNum,
  isStr,
} from '../objects/types.ts'
import { PdfParseError, EncryptedPdfError } from '../util/errors.ts'
import { decodeStream } from '../streams/decode.ts'
import { Lexer } from './lexer.ts'
import { ObjectParser } from './object_parser.ts'
import { parseXref, bruteForceXref, type XrefTable } from './xref.ts'
import { parseObjStm } from './objstm.ts'
import { buildDecryptor, type Decryptor } from './decrypt.ts'

const INHERITED = ['Resources', 'MediaBox', 'CropBox', 'Rotate'] as const

export class PdfReaderDocument {
  readonly xref: XrefTable
  private readonly cache = new Map<number, PdfObject>()
  private readonly objStmCache = new Map<number, Map<number, PdfObject>>()
  private readonly decryptor?: Decryptor

  constructor(
    readonly buf: Uint8Array,
    opts: { password?: string } = {},
  ) {
    if (opts.password) {
      // M13 only validates the empty user password.
      throw new EncryptedPdfError(
        'Password-protected PDFs are not supported (empty password only)',
      )
    }
    let xref: XrefTable
    try {
      xref = parseXref(buf)
      if (!xref.trailer.entries.has('Root')) xref = bruteForceXref(buf)
    } catch {
      xref = bruteForceXref(buf)
    }
    this.xref = xref

    const encEntry = xref.trailer.entries.get('Encrypt')
    if (encEntry) {
      const encNum = isRef(encEntry) ? encEntry.num : -1
      const encDict = this.resolve(encEntry)
      const idArr = xref.trailer.entries.get('ID')
      const idFirst =
        idArr && isArr(idArr) && idArr.items[0] && isStr(idArr.items[0]!)
          ? idArr.items[0]!.value
          : new Uint8Array(0)
      if (encDict && isDict(encDict)) {
        this.decryptor = buildDecryptor(encDict, idFirst, encNum)
      }
    }
  }

  // ── Object resolution ────────────────────────────────────────────────────

  getObject(numOrRef: number | PdfObject, gen = 0): PdfObject {
    let num: number
    let g = gen
    if (typeof numOrRef === 'number') num = numOrRef
    else if (isRef(numOrRef)) {
      num = numOrRef.num
      g = numOrRef.gen
    } else return numOrRef

    const cached = this.cache.get(num)
    if (cached) return cached

    const entry = this.xref.entries.get(num)
    if (!entry) return { kind: 'null' }

    let value: PdfObject
    if (entry.type === 'n') {
      try {
        const parser = new ObjectParser(new Lexer(this.buf, entry.offset), (o) =>
          this.toNumber(o),
        )
        const parsed = parser.parseIndirectAt(entry.offset)
        value = parsed.value
        if (this.decryptor && num !== this.decryptor.encryptObjNum) {
          value = this.decryptDeep(value, num, entry.gen ?? g)
        }
      } catch (e) {
        if (e instanceof PdfParseError) return { kind: 'null' }
        throw e
      }
    } else {
      value = this.fromObjStm(entry.streamObj, entry.index, num)
    }
    this.cache.set(num, value)
    return value
  }

  /** Dereference one level (ref → object); pass-through otherwise. */
  resolve(o: PdfObject | undefined): PdfObject | undefined {
    if (!o) return undefined
    return isRef(o) ? this.getObject(o) : o
  }

  private toNumber(o: PdfObject): number | undefined {
    const r = this.resolve(o)
    return r && isNum(r) ? r.value : undefined
  }

  private fromObjStm(streamObj: number, index: number, want: number): PdfObject {
    let contents = this.objStmCache.get(streamObj)
    if (!contents) {
      const stm = this.getObject(streamObj)
      if (!isStream(stm)) return { kind: 'null' }
      const data = this.getStreamData(stm, streamObj)
      contents = parseObjStm(stm.dict, data).objects
      this.objStmCache.set(streamObj, contents)
    }
    return contents.get(want) ?? { kind: 'null' }
  }

  // ── Streams ──────────────────────────────────────────────────────────────

  /** Decrypt (if needed) then run the filter chain. */
  getStreamData(stream: PdfStream, objNum: number, gen = 0): Uint8Array {
    let raw = stream.data
    const type = stream.dict.entries.get('Type')
    const isXref = type && isName(type) && type.value === 'XRef'
    if (this.decryptor && !isXref && objNum !== this.decryptor.encryptObjNum) {
      raw = this.decryptor.decrypt(objNum, gen, raw, false)
    }
    return decodeStream(stream.dict, raw, (o) => this.resolve(o))
  }

  private decryptDeep(o: PdfObject, num: number, gen: number): PdfObject {
    const d = this.decryptor!
    const walk = (x: PdfObject): PdfObject => {
      if (x.kind === 'str') {
        return { ...x, value: d.decrypt(num, gen, x.value, true) }
      }
      if (x.kind === 'arr') return { kind: 'arr', items: x.items.map(walk) }
      if (x.kind === 'dict') {
        const e = new Map<string, PdfObject>()
        for (const [k, v] of x.entries) e.set(k, walk(v))
        return { kind: 'dict', entries: e }
      }
      if (x.kind === 'stream') {
        const e = new Map<string, PdfObject>()
        for (const [k, v] of x.dict.entries) e.set(k, walk(v))
        return { kind: 'stream', dict: { kind: 'dict', entries: e }, data: x.data }
      }
      return x
    }
    return walk(o)
  }

  // ── Catalog / pages ──────────────────────────────────────────────────────

  get trailer(): PdfDictionary {
    return this.xref.trailer
  }

  catalog(): PdfDictionary {
    const root = this.resolve(this.trailer.entries.get('Root'))
    if (!root || !isDict(root)) throw new PdfParseError('Missing document catalog')
    return root
  }

  /** Leaf page dictionaries in document order, with inherited attributes. */
  pages(): PdfDictionary[] {
    const out: PdfDictionary[] = []
    const seen = new Set<PdfObject>()
    const root = this.resolve(this.catalog().entries.get('Pages'))
    if (!root || !isDict(root)) throw new PdfParseError('Missing page tree root')

    const visit = (nodeRef: PdfObject | undefined, inherited: Map<string, PdfObject>) => {
      const node = this.resolve(nodeRef)
      if (!node || !isDict(node) || seen.has(node)) return
      seen.add(node)
      const merged = new Map(inherited)
      for (const key of INHERITED) {
        const v = node.entries.get(key)
        if (v) merged.set(key, v)
      }
      const type = node.entries.get('Type')
      const kids = node.entries.get('Kids')
      if (kids && isArr(kids)) {
        for (const kid of kids.items) visit(kid, merged)
      } else if (!type || (isName(type) && type.value === 'Page') || node.entries.has('Contents')) {
        const leaf = new Map(merged)
        for (const [k, v] of node.entries) leaf.set(k, v)
        out.push({ kind: 'dict', entries: leaf })
      }
    }
    visit(root, new Map())
    return out
  }

  /** Concatenated, decoded content-stream bytes for a page. */
  pageContent(page: PdfDictionary): Uint8Array {
    const c = this.resolve(page.entries.get('Contents'))
    const streams: PdfStream[] = []
    const refsNum: number[] = []
    const collect = (obj: PdfObject | undefined, ref?: PdfObject) => {
      const r = this.resolve(obj)
      if (r && isStream(r)) {
        streams.push(r)
        refsNum.push(ref && isRef(ref) ? ref.num : -1)
      }
    }
    if (c && isArr(c)) {
      const raw = page.entries.get('Contents')
      const items = raw && isArr(raw) ? raw.items : c.items
      for (const it of items) collect(it, it)
    } else {
      collect(c, page.entries.get('Contents'))
    }
    const parts: Uint8Array[] = []
    for (let i = 0; i < streams.length; i++) {
      parts.push(this.getStreamData(streams[i]!, refsNum[i]!))
      parts.push(Uint8Array.of(0x0a))
    }
    const total = parts.reduce((a, p) => a + p.length, 0)
    const out = new Uint8Array(total)
    let o = 0
    for (const p of parts) {
      out.set(p, o)
      o += p.length
    }
    return out
  }

  get encrypted(): boolean {
    return this.decryptor !== undefined || this.trailer.entries.has('Encrypt')
  }
}
