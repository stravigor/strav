/**
 * CIE-based color spaces (spec §9.1): CalGray, CalRGB and Lab. These are
 * device-independent array color spaces with a parameter dictionary; no
 * profile is embedded. D50 is the default white point.
 */

import { arr, dict, name, num } from '../objects/types.ts'
import type { PdfObject } from '../objects/types.ts'
import type { ManagedColorSpace } from './space.ts'
import { managedColor } from './space.ts'
import type { Color } from './color.ts'

const D50: [number, number, number] = [0.9505, 1.0, 1.089]

class ArrayColorSpace implements ManagedColorSpace {
  constructor(
    readonly id: string,
    readonly components: number,
    private readonly obj: PdfObject
  ) {}
  build(): PdfObject {
    return this.obj
  }
  color(...comps: number[]): Color {
    return managedColor(this, comps)
  }
}

let cieCounter = 0

export function calGray(opts: { whitePoint?: [number, number, number]; gamma?: number } = {}) {
  const params = dict({ WhitePoint: arr((opts.whitePoint ?? D50).map(num)) })
  if (opts.gamma !== undefined) params.entries.set('Gamma', num(opts.gamma))
  return new ArrayColorSpace(`calgray:${cieCounter++}`, 1, arr([name('CalGray'), params]))
}

export function calRGB(
  opts: {
    whitePoint?: [number, number, number]
    gamma?: [number, number, number]
    matrix?: number[]
  } = {}
) {
  const params = dict({ WhitePoint: arr((opts.whitePoint ?? D50).map(num)) })
  if (opts.gamma) params.entries.set('Gamma', arr(opts.gamma.map(num)))
  if (opts.matrix) params.entries.set('Matrix', arr(opts.matrix.map(num)))
  return new ArrayColorSpace(`calrgb:${cieCounter++}`, 3, arr([name('CalRGB'), params]))
}

/** Lab color space. `range` bounds the a and b axes (default [-100,100,-100,100]). */
export function lab(
  opts: { whitePoint?: [number, number, number]; range?: number[] } = {}
) {
  const params = dict({
    WhitePoint: arr((opts.whitePoint ?? D50).map(num)),
    Range: arr((opts.range ?? [-100, 100, -100, 100]).map(num)),
  })
  return new ArrayColorSpace(`lab:${cieCounter++}`, 3, arr([name('Lab'), params]))
}

export type { ArrayColorSpace }
