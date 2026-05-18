/**
 * Public read-side API (M13): layout-aware plain-text extraction from an
 * existing PDF. `extractText` is the headline ergonomic entry point;
 * `PdfReader` is a reusable handle for lazy/repeated page access.
 *
 * Scope: text content only. No OCR (scanned/image-only pages yield no text),
 * no column/table reconstruction, no annotation/form-field values, empty
 * user password only.
 */

import { type PdfDictionary, isDict, isStr } from '../objects/types.ts'
import { PdfReaderDocument } from './document.ts'
import { interpretText } from './text_interpreter.ts'
import { runsToText } from './layout.ts'

export interface ExtractOptions {
  /** 1-based pages; default all. */
  pages?: number | number[] | { from?: number; to?: number }
  /** Collapse whitespace and trim. Default true. */
  normalizeWhitespace?: boolean
  /** Only the empty password is supported; non-empty throws. */
  password?: string
}

export interface ExtractedPage {
  number: number
  text: string
}

export interface PdfInfo {
  title?: string
  author?: string
  subject?: string
  keywords?: string
  creator?: string
  producer?: string
  creationDate?: string
  modDate?: string
  pageCount: number
  encrypted: boolean
}

export interface ExtractResult {
  pages: ExtractedPage[]
  /** Page texts joined by the form-feed page separator. */
  text: string
  info: PdfInfo
}

function toU8(b: Uint8Array | ArrayBuffer): Uint8Array {
  return b instanceof Uint8Array ? b : new Uint8Array(b)
}

/** Decode a PDF text string: UTF-16BE if BOM-prefixed, else Latin-1/PDFDoc. */
function decodeTextString(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let s = ''
    for (let i = 2; i + 1 < bytes.length; i += 2) s += String.fromCharCode((bytes[i]! << 8) | bytes[i + 1]!)
    return s
  }
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return s
}

export class PdfReader {
  private readonly doc: PdfReaderDocument
  private readonly pageList: PdfDictionary[]

  private constructor(bytes: Uint8Array, opts: { password?: string }) {
    this.doc = new PdfReaderDocument(bytes, opts)
    this.pageList = this.doc.pages()
  }

  static async open(
    bytes: Uint8Array | ArrayBuffer,
    opts: { password?: string } = {},
  ): Promise<PdfReader> {
    return new PdfReader(toU8(bytes), opts)
  }

  get pageCount(): number {
    return this.pageList.length
  }

  get encrypted(): boolean {
    return this.doc.encrypted
  }

  get info(): PdfInfo {
    const out: PdfInfo = { pageCount: this.pageCount, encrypted: this.encrypted }
    const infoObj = this.doc.resolve(this.doc.trailer.entries.get('Info'))
    if (infoObj && isDict(infoObj)) {
      const get = (k: string): string | undefined => {
        const v = this.doc.resolve(infoObj.entries.get(k))
        return v && isStr(v) ? decodeTextString(v.value) : undefined
      }
      out.title = get('Title')
      out.author = get('Author')
      out.subject = get('Subject')
      out.keywords = get('Keywords')
      out.creator = get('Creator')
      out.producer = get('Producer')
      out.creationDate = get('CreationDate')
      out.modDate = get('ModDate')
    }
    return out
  }

  pageText(pageNumber: number, opts: { normalizeWhitespace?: boolean } = {}): string {
    const page = this.pageList[pageNumber - 1]
    if (!page) return ''
    const resources = this.doc.resolve(page.entries.get('Resources'))
    const content = this.doc.pageContent(page)
    const runs = interpretText(
      content,
      resources && isDict(resources) ? resources : undefined,
      this.doc,
    )
    return runsToText(runs, opts.normalizeWhitespace ?? true)
  }

  extractText(opts: ExtractOptions = {}): ExtractResult {
    const nums = selectPages(opts.pages, this.pageCount)
    const norm = opts.normalizeWhitespace ?? true
    const pages = nums.map((n) => ({ number: n, text: this.pageText(n, { normalizeWhitespace: norm }) }))
    return { pages, text: pages.map((p) => p.text).join('\f'), info: this.info }
  }
}

function selectPages(
  spec: ExtractOptions['pages'],
  count: number,
): number[] {
  const all = Array.from({ length: count }, (_, i) => i + 1)
  if (spec === undefined) return all
  if (typeof spec === 'number') return spec >= 1 && spec <= count ? [spec] : []
  if (Array.isArray(spec)) return spec.filter((n) => n >= 1 && n <= count)
  const from = Math.max(1, spec.from ?? 1)
  const to = Math.min(count, spec.to ?? count)
  const out: number[] = []
  for (let n = from; n <= to; n++) out.push(n)
  return out
}

export async function extractText(
  bytes: Uint8Array | ArrayBuffer,
  opts: ExtractOptions = {},
): Promise<ExtractResult> {
  const reader = await PdfReader.open(bytes, { password: opts.password })
  return reader.extractText(opts)
}
