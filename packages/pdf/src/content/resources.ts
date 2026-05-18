/**
 * Per-content-stream resource collector (spec §6.3 Resources). Hands out
 * deterministic resource names (`F1`/`Im1`/…) on first use and keeps insertion
 * order so the emitted `/Resources` dictionary is byte-stable.
 *
 * Fonts and image XObjects are collected; ExtGState/pattern categories are
 * added in later milestones following the same pattern.
 */

import type { PdfFont } from '../fonts/font.ts'
import type { PdfImage } from '../images/image.ts'
import type { ManagedColorSpace } from '../color/space.ts'

export class ResourceCollector {
  private readonly fonts = new Map<string, { name: string; font: PdfFont }>()
  private readonly images = new Map<PdfImage, string>()
  private readonly colorSpaces = new Map<string, { name: string; cs: ManagedColorSpace }>()

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

  get isEmpty(): boolean {
    return this.fonts.size === 0 && this.images.size === 0 && this.colorSpaces.size === 0
  }
}
