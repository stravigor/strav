/**
 * Extended graphics state (spec §13). Transparency lives in an ExtGState
 * object selected with the `gs` operator: stroke/fill constant alpha and a
 * blend mode. The object is registered in `/Resources /ExtGState`.
 */

import { dict, name, num } from '../objects/types.ts'
import type { PdfObject } from '../objects/types.ts'
import type { ObjectTable } from '../document/object_table.ts'

export type BlendMode =
  | 'Normal'
  | 'Multiply'
  | 'Screen'
  | 'Overlay'
  | 'Darken'
  | 'Lighten'
  | 'ColorDodge'
  | 'ColorBurn'
  | 'HardLight'
  | 'SoftLight'
  | 'Difference'
  | 'Exclusion'
  | 'Hue'
  | 'Saturation'
  | 'Color'
  | 'Luminosity'

export interface ExtGStateOptions {
  /** Stroking constant alpha `CA` in [0,1]. */
  strokeAlpha?: number
  /** Non-stroking (fill) constant alpha `ca` in [0,1]. */
  fillAlpha?: number
  /** Blend mode `BM` (default `Normal`). */
  blendMode?: BlendMode
}

class ExtGState {
  readonly id: string

  constructor(
    private readonly opts: ExtGStateOptions,
    tag: number
  ) {
    const parts = [
      opts.strokeAlpha !== undefined ? `CA${opts.strokeAlpha}` : '',
      opts.fillAlpha !== undefined ? `ca${opts.fillAlpha}` : '',
      opts.blendMode ?? '',
    ]
    this.id = `gs:${parts.join('|')}:${tag}`
  }

  build(_table: ObjectTable): PdfObject {
    const d = dict({ Type: name('ExtGState') })
    if (this.opts.strokeAlpha !== undefined) d.entries.set('CA', num(this.opts.strokeAlpha))
    if (this.opts.fillAlpha !== undefined) d.entries.set('ca', num(this.opts.fillAlpha))
    if (this.opts.blendMode) d.entries.set('BM', name(this.opts.blendMode))
    return d
  }
}

let gsCounter = 0

/** Create an ExtGState handle (use with `ContentStream.setExtGState`). */
export function extGState(opts: ExtGStateOptions): ExtGState {
  return new ExtGState(opts, gsCounter++)
}

export type { ExtGState }
