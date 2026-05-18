/**
 * A page (spec §6.3). Holds geometry and a lazily-created content stream.
 * The page dictionary itself is built by the document serializer at save time.
 */

import { ContentStream } from '../content/content_stream.ts'
import type { PageSize, Rect } from './types.ts'

export class Page {
  readonly index: number
  readonly size: PageSize
  readonly rotation: 0 | 90 | 180 | 270

  /** Optional page boxes (points). MediaBox defaults to the page size. */
  private mediaBox?: Rect
  private cropBox?: Rect
  private bleedBox?: Rect
  private trimBox?: Rect
  private artBox?: Rect

  private contentStream?: ContentStream

  constructor(index: number, size: PageSize, rotation: 0 | 90 | 180 | 270 = 0) {
    this.index = index
    this.size = size
    this.rotation = rotation
  }

  setMediaBox(box: Rect): void {
    this.mediaBox = box
  }
  setCropBox(box: Rect): void {
    this.cropBox = box
  }
  /** For PDF/X-4 (enforced in M11). */
  setBleedBox(box: Rect): void {
    this.bleedBox = box
  }
  /** For PDF/X-4 (enforced in M11). */
  setTrimBox(box: Rect): void {
    this.trimBox = box
  }
  setArtBox(box: Rect): void {
    this.artBox = box
  }

  /** Append-only content-stream builder for this page (spec §8). */
  content(): ContentStream {
    if (!this.contentStream) this.contentStream = new ContentStream()
    return this.contentStream
  }

  // ── Internal: consumed by the document serializer ───────────────────────

  /** @internal */
  getContentStream(): ContentStream | undefined {
    return this.contentStream
  }

  /** @internal The effective MediaBox (defaults to the page size). */
  getMediaBox(): Rect {
    return this.mediaBox ?? { x: 0, y: 0, w: this.size.widthPt, h: this.size.heightPt }
  }

  /** @internal Optional boxes, present only when explicitly set. */
  getOptionalBoxes(): { key: string; rect: Rect }[] {
    const out: { key: string; rect: Rect }[] = []
    if (this.cropBox) out.push({ key: 'CropBox', rect: this.cropBox })
    if (this.bleedBox) out.push({ key: 'BleedBox', rect: this.bleedBox })
    if (this.trimBox) out.push({ key: 'TrimBox', rect: this.trimBox })
    if (this.artBox) out.push({ key: 'ArtBox', rect: this.artBox })
    return out
  }
}
