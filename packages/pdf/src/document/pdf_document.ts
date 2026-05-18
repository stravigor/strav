/**
 * Public facade (spec §16). Owns the object table, builds the document graph
 * during the build pass, and emits bytes during the serialize pass.
 */

import { createHash, randomBytes } from 'node:crypto'
import { PdfGenError, UnsupportedFontError, ConformanceError } from '../util/errors.ts'
import type { IndirectRef, PdfObject } from '../objects/types.ts'
import { arr, dict, name, num } from '../objects/types.ts'
import { textString } from '../objects/string.ts'
import { encodeObject } from '../objects/encode.ts'
import { makeContentStream, makeStream } from '../streams/stream.ts'
import { parseIccProfile } from '../color/icc.ts'
import { buildInfoDict } from '../metadata/info_dict.ts'
import { buildXmpStream } from '../metadata/xmp.ts'
import { validateConformance } from '../standards/index.ts'
import { extGState, type ExtGStateOptions } from '../ext-gstate/ext_gstate.ts'
import { tilingPattern, type TilingPatternOptions } from '../patterns/tiling_pattern.ts'
import {
  axialShading,
  radialShading,
  shadingPattern,
  type AxialOptions,
  type RadialOptions,
  type Shading,
} from '../patterns/shading.ts'
import type { Writable } from 'node:stream'
import type { ByteSink } from '../output/byte_sink.ts'
import { BufferSink } from '../output/buffer_sink.ts'
import { StreamSink } from '../output/stream_sink.ts'
import { ObjectTable } from './object_table.ts'
import { buildPageTree } from './page_tree.ts'
import { buildCatalog } from './catalog.ts'
import { serializeDocument } from './xref.ts'
import { Page } from './page.ts'
import { rectToBox } from './types.ts'
import type {
  AddPageOptions,
  CreateOptions,
  DocumentInfo,
  ConformanceLevel,
  OutputIntentConfig,
} from './types.ts'

const PRODUCER = '@strav/pdf'

export class PdfDocument {
  private readonly info: DocumentInfo
  private conformance: ConformanceLevel
  private readonly creationDate: Date
  private readonly fixedId?: Uint8Array
  private readonly pages: Page[] = []
  private outputIntent?: OutputIntentConfig
  private saved = false

  private constructor(opts: CreateOptions) {
    this.info = opts.info ?? {}
    this.conformance = opts.conformance ?? null
    this.creationDate = opts.creationDate ?? new Date()
    this.fixedId = opts.documentId ? normalizeId(opts.documentId) : undefined
  }

  /** Create a new, empty document. */
  static create(opts: CreateOptions = {}): PdfDocument {
    return new PdfDocument(opts)
  }

  addPage(opts: AddPageOptions): Page {
    if (this.saved) {
      throw new PdfGenError('PDF_DOCUMENT_FINALIZED', 'Cannot add a page after save()')
    }
    const page = new Page(this.pages.length, opts.size, opts.rotation ?? 0)
    this.pages.push(page)
    return page
  }

  /**
   * Set the document's output intent (spec §9.3). Embeds the destination ICC
   * profile and adds it to the catalog `/OutputIntents`. Required for PDF/X-4.
   */
  setOutputIntent(cfg: OutputIntentConfig): this {
    if (this.saved) {
      throw new PdfGenError('PDF_DOCUMENT_FINALIZED', 'Cannot set output intent after save()')
    }
    parseIccProfile(cfg.destOutputProfile) // validate eagerly
    this.outputIntent = cfg
    return this
  }

  /** Create an ExtGState (spec §13). Convenience for {@link extGState}. */
  createExtGState(opts: ExtGStateOptions) {
    return extGState(opts)
  }

  /** Create a tiling pattern (spec §12.1). */
  createTilingPattern(opts: TilingPatternOptions) {
    return tilingPattern(opts)
  }

  /** Create an axial (linear) shading (spec §12.2). */
  createAxialShading(opts: AxialOptions) {
    return axialShading(opts)
  }

  /** Create a radial shading (spec §12.2). */
  createRadialShading(opts: RadialOptions) {
    return radialShading(opts)
  }

  /** Wrap a shading as a fill/stroke pattern. */
  createShadingPattern(shading: Shading, matrix?: number[]) {
    return shadingPattern(shading, matrix)
  }

  /** Conformance target. */
  getConformance(): ConformanceLevel {
    return this.conformance
  }

  /**
   * Opt into a conformance mode (spec §15). Validated at `save()`, which
   * throws `ConformanceError` listing every violation. A Standard-14 font
   * used under any mode throws `UnsupportedFontError` (fail-fast).
   */
  setConformance(level: ConformanceLevel): this {
    if (this.saved) {
      throw new PdfGenError('PDF_DOCUMENT_FINALIZED', 'Cannot set conformance after save()')
    }
    this.conformance = level
    return this
  }

  /** Serialize and return the complete PDF bytes (spec §3.2, §3.3). */
  async save(): Promise<Uint8Array> {
    const sink = new BufferSink()
    this.finalize(sink)
    return sink.toBytes()
  }

  /**
   * Serialize, streaming to a Node `Writable` (spec §3.3) — no full-document
   * buffer. Resolves once the stream has flushed; rejects on a stream error
   * or a build/conformance error (the same as {@link save}).
   */
  async saveToStream(writable: Writable): Promise<void> {
    const sink = new StreamSink(writable)
    this.finalize(sink)
    await sink.done()
  }

  private finalize(sink: ByteSink): void {
    if (this.saved) {
      throw new PdfGenError('PDF_DOCUMENT_FINALIZED', 'Document already saved')
    }
    if (this.pages.length === 0) {
      throw new PdfGenError('PDF_INVALID_PAGE', 'Document has no pages')
    }

    // Conformance (spec §15) — before finalizing so the caller may fix and
    // retry. Standard-14 fails fast (a distinct, typed error) ahead of the
    // aggregate validation.
    if (this.conformance) {
      for (const page of this.pages) {
        const cs = page.getContentStream()
        for (const font of cs ? cs.usedFonts() : []) {
          if (font.isStandard14) {
            throw new UnsupportedFontError(
              `Standard-14 font "${font.baseFont}" cannot be used under ${this.conformance}; ` +
                'embed a TrueType/OpenType font instead'
            )
          }
        }
      }
      const profileColorSpace = this.outputIntent
        ? parseIccProfile(this.outputIntent.destOutputProfile).colorSpace
        : undefined
      const violations = validateConformance(this.conformance, {
        pages: this.pages.map(p => ({
          hasTrimOrArt: p
            .getOptionalBoxes()
            .some(b => b.key === 'TrimBox' || b.key === 'ArtBox'),
        })),
        outputIntent: { present: !!this.outputIntent, profileColorSpace },
      })
      if (violations.length) {
        throw new ConformanceError(
          `${this.conformance} conformance failed:\n  - ${violations.join('\n  - ')}`,
          violations
        )
      }
    }

    this.saved = true

    const table = new ObjectTable()

    // Info dictionary (spec §14.1). ModDate == CreateDate for determinism.
    const infoRef = table.add(buildInfoDict(this.info, this.creationDate, PRODUCER))

    // Leaf page refs, then the page tree, then the leaf page dicts.
    const leafRefs = this.pages.map(() => table.allocate())
    const { rootRef, parentOf } = buildPageTree(table, leafRefs)

    this.pages.forEach((page, i) => {
      const leafRef = leafRefs[i]!
      const parent = parentOf.get(leafRef.num)!
      table.set(leafRef, this.buildPageDict(table, page, parent))
    })

    const catalog = buildCatalog(rootRef)
    if (this.outputIntent) {
      catalog.entries.set('OutputIntents', arr([this.buildOutputIntent(table)]))
    }
    // XMP is always present (spec §14.2) — uncompressed /Metadata stream.
    catalog.entries.set(
      'Metadata',
      table.add(
        buildXmpStream({
          info: this.info,
          creationDate: this.creationDate,
          producer: PRODUCER,
          conformance: this.conformance,
        })
      )
    )
    const catalogRef = table.add(catalog)

    const id = this.computeId(infoRef, table)

    serializeDocument({ table, root: catalogRef, info: infoRef, id, sink })
  }

  // ── build helpers ───────────────────────────────────────────────────────

  private buildOutputIntent(table: ObjectTable): PdfObject {
    const cfg = this.outputIntent!
    const profile = parseIccProfile(cfg.destOutputProfile)
    const profileRef = table.add(
      makeStream(cfg.destOutputProfile, {
        filter: 'FlateDecode',
        extra: { N: num(profile.components) },
      })
    )
    // These identifier fields are ASCII by convention (FOGRA39, URLs);
    // PDF/X readers expect a readable literal string, not UTF-16BE.
    const ascii = (s: string) => textString(s, { encoding: 'pdfdoc' })
    const d = dict({
      Type: name('OutputIntent'),
      S: name(cfg.subtype),
      OutputConditionIdentifier: ascii(cfg.outputConditionIdentifier),
      DestOutputProfile: profileRef,
    })
    if (cfg.outputCondition) d.entries.set('OutputCondition', ascii(cfg.outputCondition))
    if (cfg.registryName) d.entries.set('RegistryName', ascii(cfg.registryName))
    if (cfg.info) d.entries.set('Info', ascii(cfg.info))
    return d
  }

  private buildPageDict(table: ObjectTable, page: Page, parent: IndirectRef) {
    const mb = page.getMediaBox()
    const entries: Record<string, PdfObject> = {
      Type: name('Page'),
      Parent: parent,
      MediaBox: arr(rectToBox(mb).map(num)),
      Resources: dict({}),
    }
    if (page.rotation !== 0) entries.Rotate = num(page.rotation)
    for (const { key, rect } of page.getOptionalBoxes()) {
      entries[key] = arr(rectToBox(rect).map(num))
    }

    const cs = page.getContentStream()
    if (cs) {
      cs.assertBalanced()
      // Standard-14-under-conformance is checked up front in save().
      const contentRef = table.add(makeContentStream(cs.toBytes()))
      entries.Contents = contentRef
      entries.Resources = cs.buildResources(table)
    }
    return dict(entries)
  }

  /**
   * `/ID` array (spec §6.5): a permanent id and a per-save id. With a fixed
   * `documentId` (or fixed creationDate-driven content) the output is
   * byte-identical across runs (spec §16.3).
   */
  private computeId(infoRef: IndirectRef, table: ObjectTable): [Uint8Array, Uint8Array] {
    if (this.fixedId) return [this.fixedId, this.fixedId]
    const infoObj = table.get(infoRef.num)!
    const permanent = createHash('md5').update(encodeObject(infoObj)).digest()
    const perSave = new Uint8Array(randomBytes(16))
    return [new Uint8Array(permanent), perSave]
  }
}

function normalizeId(id: string | Uint8Array): Uint8Array {
  if (typeof id !== 'string') {
    if (id.length !== 16) {
      throw new PdfGenError('PDF_INVALID_OBJECT', 'documentId bytes must be exactly 16 long')
    }
    return id
  }
  if (!/^[0-9a-fA-F]{32}$/.test(id)) {
    throw new PdfGenError('PDF_INVALID_OBJECT', 'documentId hex string must be 32 hex chars')
  }
  const out = new Uint8Array(16)
  for (let i = 0; i < 16; i++) out[i] = parseInt(id.slice(i * 2, i * 2 + 2), 16)
  return out
}
