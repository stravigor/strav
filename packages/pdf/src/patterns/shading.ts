/**
 * Axial (type 2) and radial (type 3) shadings (spec §12.2). The color ramp is
 * a Type-2 exponential function for two stops, or a Type-3 stitching function
 * for more. Types 1 and 4–7 are reachable by adding raw objects.
 *
 * A `Shading` paints via the `sh` operator; wrap it with `shadingPattern` to
 * use it as a fill/stroke pattern (PatternType 2).
 */

import { PdfGenError } from '../util/errors.ts'
import { arr, bool, dict, name, num } from '../objects/types.ts'
import type { PdfObject } from '../objects/types.ts'
import type { ObjectTable } from '../document/object_table.ts'
import type { DeviceColor } from '../color/color.ts'
import { deviceComponents, deviceSpaceName } from '../color/color.ts'

export interface ColorStop {
  /** Position in [0,1]. */
  offset: number
  color: DeviceColor
}

function buildFunction(stops: ColorStop[]): PdfObject {
  if (stops.length < 2) {
    throw new PdfGenError('PDF_INVALID_COLOR', 'A shading needs at least two color stops')
  }
  const space = stops[0]!.color.space
  for (const s of stops) {
    if (s.color.space !== space) {
      throw new PdfGenError('PDF_INVALID_COLOR', 'All shading stops must share one color space')
    }
  }
  const seg = (a: DeviceColor, b: DeviceColor): PdfObject =>
    dict({
      FunctionType: num(2),
      Domain: arr([num(0), num(1)]),
      C0: arr(deviceComponents(a).map(num)),
      C1: arr(deviceComponents(b).map(num)),
      N: num(1),
    })

  if (stops.length === 2) return seg(stops[0]!.color, stops[1]!.color)

  // Type-3 stitching of consecutive Type-2 segments.
  const fns: PdfObject[] = []
  const bounds: PdfObject[] = []
  const encode: PdfObject[] = []
  for (let i = 0; i < stops.length - 1; i++) {
    fns.push(seg(stops[i]!.color, stops[i + 1]!.color))
    encode.push(num(0), num(1))
    if (i > 0) bounds.push(num(stops[i]!.offset))
  }
  return dict({
    FunctionType: num(3),
    Domain: arr([num(0), num(1)]),
    Functions: arr(fns),
    Bounds: arr(bounds),
    Encode: arr(encode),
  })
}

function colorSpaceName(stops: ColorStop[]): string {
  return deviceSpaceName(stops[0]!.color)
}

function normalizeStops(colors: DeviceColor[] | ColorStop[]): ColorStop[] {
  const first = colors[0]
  if (first && 'color' in first) return colors as ColorStop[]
  const cs = colors as DeviceColor[]
  return cs.map((color, i) => ({ offset: i / (cs.length - 1), color }))
}

class Shading {
  readonly id: string
  constructor(
    private readonly shadingType: 2 | 3,
    private readonly coords: number[],
    private readonly stops: ColorStop[],
    private readonly extend: [boolean, boolean],
    tag: number
  ) {
    this.id = `sh${shadingType}:${tag}`
  }

  build(_table: ObjectTable): PdfObject {
    return dict({
      ShadingType: num(this.shadingType),
      ColorSpace: name(colorSpaceName(this.stops)),
      Coords: arr(this.coords.map(num)),
      Function: buildFunction(this.stops),
      Extend: arr([bool(this.extend[0]), bool(this.extend[1])]),
    })
  }
}

let shCounter = 0

export interface AxialOptions {
  from: [number, number]
  to: [number, number]
  colors: DeviceColor[] | ColorStop[]
  extend?: [boolean, boolean]
}

/** A type-2 (axial / linear-gradient) shading. */
export function axialShading(o: AxialOptions): Shading {
  return new Shading(
    2,
    [o.from[0], o.from[1], o.to[0], o.to[1]],
    normalizeStops(o.colors),
    o.extend ?? [true, true],
    shCounter++
  )
}

export interface RadialOptions {
  from: { x: number; y: number; r: number }
  to: { x: number; y: number; r: number }
  colors: DeviceColor[] | ColorStop[]
  extend?: [boolean, boolean]
}

/** A type-3 (radial) shading. */
export function radialShading(o: RadialOptions): Shading {
  return new Shading(
    3,
    [o.from.x, o.from.y, o.from.r, o.to.x, o.to.y, o.to.r],
    normalizeStops(o.colors),
    o.extend ?? [true, true],
    shCounter++
  )
}

class ShadingPattern {
  readonly id: string
  constructor(
    private readonly shading: Shading,
    private readonly matrix: number[] | undefined,
    tag: number
  ) {
    this.id = `shp:${shading.id}:${tag}`
  }

  build(table: ObjectTable): PdfObject {
    const d = dict({
      Type: name('Pattern'),
      PatternType: num(2),
      Shading: this.shading.build(table),
    })
    if (this.matrix) d.entries.set('Matrix', arr(this.matrix.map(num)))
    return table.add(d)
  }
}

let shpCounter = 0

/** Wrap a shading as a pattern (use with `setFillPattern`/`setStrokePattern`). */
export function shadingPattern(shading: Shading, matrix?: number[]): ShadingPattern {
  return new ShadingPattern(shading, matrix, shpCounter++)
}

export type { Shading, ShadingPattern }
