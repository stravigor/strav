/**
 * Per-content-stream resource collector (spec §6.3 Resources). Hands out
 * deterministic resource names (`F1`, `F2`, …) on first use and keeps insertion
 * order so the emitted `/Resources` dictionary is byte-stable.
 *
 * Milestone 4 only collects fonts; image/ExtGState/pattern categories are added
 * in later milestones following the same pattern.
 */

import type { PdfFont } from '../fonts/font.ts'

export class ResourceCollector {
  private readonly fonts = new Map<string, { name: string; font: PdfFont }>()

  /** Register a font, returning its stable `/Font` resource name. */
  useFont(font: PdfFont): string {
    const existing = this.fonts.get(font.id)
    if (existing) return existing.name
    const name = `F${this.fonts.size + 1}`
    this.fonts.set(font.id, { name, font })
    return name
  }

  /** Fonts in first-use order. */
  usedFonts(): { name: string; font: PdfFont }[] {
    return [...this.fonts.values()]
  }

  get isEmpty(): boolean {
    return this.fonts.size === 0
  }
}
