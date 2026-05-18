/**
 * Tracked graphics state (spec §8.3). A snapshot is pushed on `q` and popped
 * on `Q`. M1–M3 track the device-graphics fields; text-state fields are
 * present but unused until M4/M5.
 */

import type { Color } from '../color/color.ts'

export type Matrix = [number, number, number, number, number, number]

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

export interface GraphicsState {
  ctm: Matrix
  strokeColor: Color
  fillColor: Color
  lineWidth: number
  lineCap: 0 | 1 | 2
  lineJoin: 0 | 1 | 2
  miterLimit: number
  dash: { array: number[]; phase: number }
  renderingIntent: string | null
}

export function initialState(): GraphicsState {
  return {
    ctm: [...IDENTITY],
    strokeColor: { space: 'DeviceGray', g: 0 },
    fillColor: { space: 'DeviceGray', g: 0 },
    lineWidth: 1,
    lineCap: 0,
    lineJoin: 0,
    miterLimit: 10,
    dash: { array: [], phase: 0 },
    renderingIntent: null,
  }
}

/** Deep-enough copy for the save/restore stack (colors are immutable values). */
export function cloneState(s: GraphicsState): GraphicsState {
  return {
    ctm: [...s.ctm],
    strokeColor: s.strokeColor,
    fillColor: s.fillColor,
    lineWidth: s.lineWidth,
    lineCap: s.lineCap,
    lineJoin: s.lineJoin,
    miterLimit: s.miterLimit,
    dash: { array: [...s.dash.array], phase: s.dash.phase },
    renderingIntent: s.renderingIntent,
  }
}

/** Multiply two matrices: result = a × b (PDF `cm` semantics, b applied first). */
export function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[1] * b[2],
    a[0] * b[1] + a[1] * b[3],
    a[2] * b[0] + a[3] * b[2],
    a[2] * b[1] + a[3] * b[3],
    a[4] * b[0] + a[5] * b[2] + b[4],
    a[4] * b[1] + a[5] * b[3] + b[5],
  ]
}
