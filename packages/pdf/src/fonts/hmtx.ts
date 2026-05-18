/**
 * `hmtx` table (spec §10.2): per-glyph advance widths in font units. The last
 * `numberOfHMetrics` entry's advance applies to all trailing glyphs (which
 * carry only a left-side bearing).
 */

export class Hmtx {
  constructor(
    private readonly hmtx: Uint8Array,
    private readonly numberOfHMetrics: number,
    private readonly numGlyphs: number
  ) {}

  /** Advance width of a glyph in font units. */
  advance(gid: number): number {
    if (gid < 0 || gid >= this.numGlyphs) return 0
    const i = gid < this.numberOfHMetrics ? gid : this.numberOfHMetrics - 1
    const o = i * 4
    return (this.hmtx[o]! << 8) | this.hmtx[o + 1]!
  }
}
