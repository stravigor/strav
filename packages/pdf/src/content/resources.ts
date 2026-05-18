/**
 * Per-content-stream resource collector (spec §6.3 Resources). Hands out
 * deterministic resource names (`F1`/`Im1`/…) on first use and keeps insertion
 * order so the emitted `/Resources` dictionary is byte-stable.
 *
 * Fonts and image XObjects are collected; ExtGState/pattern categories are
 * added in later milestones following the same pattern.
 */

import type { ObjectTable } from '../document/object_table.ts'
import type { PdfObject } from '../objects/types.ts'
import type { PdfFont } from '../fonts/font.ts'
import type { PdfImage } from '../images/image.ts'
import type { ManagedColorSpace } from '../color/space.ts'

/** Anything registered as a resource: a stable id + a builder. */
export interface Buildable {
  readonly id: string
  build(table: ObjectTable): PdfObject
}

export class ResourceCollector {
  private readonly fonts = new Map<string, { name: string; font: PdfFont }>()
  private readonly images = new Map<PdfImage, string>()
  private readonly colorSpaces = new Map<string, { name: string; cs: ManagedColorSpace }>()
  private readonly extGStates = new Map<string, { name: string; res: Buildable }>()
  private readonly patterns = new Map<string, { name: string; res: Buildable }>()
  private readonly shadings = new Map<string, { name: string; res: Buildable }>()

  /** Register a font, returning its stable `/Font` resource name. */
  useFont(font: PdfFont): string {
    const existing = this.fonts.get(font.id)
    if (existing) return existing.name
    const name = `F${this.fonts.size + 1}`
    this.fonts.set(font.id, { name, font })
    return name
  }

  /** Register an image, returning its stable `/XObject` resource name. */
  useImage(image: PdfImage): string {
    const existing = this.images.get(image)
    if (existing) return existing
    const name = `Im${this.images.size + 1}`
    this.images.set(image, name)
    return name
  }

  /** Register a managed color space, returning its `/ColorSpace` name. */
  useColorSpace(cs: ManagedColorSpace): string {
    const existing = this.colorSpaces.get(cs.id)
    if (existing) return existing.name
    const name = `CS${this.colorSpaces.size + 1}`
    this.colorSpaces.set(cs.id, { name, cs })
    return name
  }

  /** Fonts in first-use order. */
  usedFonts(): { name: string; font: PdfFont }[] {
    return [...this.fonts.values()]
  }

  /** Images in first-use order. */
  usedImages(): { name: string; image: PdfImage }[] {
    return [...this.images].map(([image, name]) => ({ name, image }))
  }

  /** Color spaces in first-use order. */
  usedColorSpaces(): { name: string; cs: ManagedColorSpace }[] {
    return [...this.colorSpaces.values()]
  }

  private use(
    map: Map<string, { name: string; res: Buildable }>,
    prefix: string,
    res: Buildable
  ): string {
    const existing = map.get(res.id)
    if (existing) return existing.name
    const name = `${prefix}${map.size + 1}`
    map.set(res.id, { name, res })
    return name
  }

  /** Register an ExtGState → `/ExtGState` name (`GS1`, …). */
  useExtGState(res: Buildable): string {
    return this.use(this.extGStates, 'GS', res)
  }

  /** Register a pattern → `/Pattern` name (`P1`, …). */
  usePattern(res: Buildable): string {
    return this.use(this.patterns, 'P', res)
  }

  /** Register a shading → `/Shading` name (`Sh1`, …). */
  useShading(res: Buildable): string {
    return this.use(this.shadings, 'Sh', res)
  }

  usedExtGStates(): { name: string; res: Buildable }[] {
    return [...this.extGStates.values()]
  }
  usedPatterns(): { name: string; res: Buildable }[] {
    return [...this.patterns.values()]
  }
  usedShadings(): { name: string; res: Buildable }[] {
    return [...this.shadings.values()]
  }

  get isEmpty(): boolean {
    return (
      this.fonts.size === 0 &&
      this.images.size === 0 &&
      this.colorSpaces.size === 0 &&
      this.extGStates.size === 0 &&
      this.patterns.size === 0 &&
      this.shadings.size === 0
    )
  }
}
