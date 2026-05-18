/**
 * Tiling pattern (spec §12.1). The draw callback receives a content-stream
 * builder scoped to the pattern cell; its own resources (colors, images,
 * fonts) are collected into the pattern's `/Resources`. A colored pattern
 * (PaintType 1) carries its own color; an uncolored one (PaintType 2) is
 * tinted by the caller's current color.
 */

import { arr, name, num } from '../objects/types.ts'
import type { PdfObject } from '../objects/types.ts'
import type { ObjectTable } from '../document/object_table.ts'
import { makeStream } from '../streams/stream.ts'
import { ContentStream } from '../content/content_stream.ts'

export interface TilingPatternOptions {
  /** Pattern cell bounding box `[llx lly urx ury]`. */
  bbox: [number, number, number, number]
  xStep: number
  yStep: number
  /** `'colored'` (default) carries its own color; `'uncolored'` is tinted. */
  paintType?: 'colored' | 'uncolored'
  /** Optional pattern→page transform. */
  matrix?: number[]
  draw: (c: ContentStream) => void
}

class TilingPattern {
  readonly id: string
  /** `'colored'` patterns set color in the cell; `'uncolored'` are tinted. */
  readonly paintType: 'colored' | 'uncolored'

  constructor(
    private readonly opts: TilingPatternOptions,
    tag: number
  ) {
    this.paintType = opts.paintType ?? 'colored'
    this.id = `tile:${tag}`
  }

  build(table: ObjectTable): PdfObject {
    const cell = new ContentStream()
    this.opts.draw(cell)
    cell.assertBalanced()
    const resources = cell.buildResources(table) // children added to table
    const [x0, y0, x1, y1] = this.opts.bbox
    const extra: Record<string, PdfObject> = {
      Type: name('Pattern'),
      PatternType: num(1),
      PaintType: num(this.paintType === 'colored' ? 1 : 2),
      TilingType: num(1),
      BBox: arr([x0, y0, x1, y1].map(num)),
      XStep: num(this.opts.xStep),
      YStep: num(this.opts.yStep),
      Resources: resources,
    }
    if (this.opts.matrix) extra.Matrix = arr(this.opts.matrix.map(num))
    return table.add(makeStream(cell.toBytes(), { filter: 'FlateDecode', extra }))
  }
}

let tileCounter = 0

/** Create a tiling pattern (use with `ContentStream.setFillPattern`). */
export function tilingPattern(opts: TilingPatternOptions): TilingPattern {
  return new TilingPattern(opts, tileCounter++)
}

export type { TilingPattern }
