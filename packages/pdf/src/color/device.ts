/**
 * Device color-space operator emission (spec §9.1). Maps a {@link Color} to
 * the shortcut color operators (`g`/`rg`/`k` for fill, `G`/`RG`/`K` for
 * stroke). Numbers go through the shared serializer for determinism (§8.5).
 */

import { formatNumber } from '../objects/number.ts'
import { OP } from '../content/operators.ts'
import type { Color } from './color.ts'

function n(v: number): string {
  return formatNumber(v)
}

/** Operator line that sets the non-stroking (fill) color. */
export function fillColorOp(c: Color): string {
  switch (c.space) {
    case 'DeviceGray':
      return `${n(c.g)} ${OP.fillGray}`
    case 'DeviceRGB':
      return `${n(c.r)} ${n(c.g)} ${n(c.b)} ${OP.fillRGB}`
    case 'DeviceCMYK':
      return `${n(c.c)} ${n(c.m)} ${n(c.y)} ${n(c.k)} ${OP.fillCMYK}`
  }
}

/** Operator line that sets the stroking color. */
export function strokeColorOp(c: Color): string {
  switch (c.space) {
    case 'DeviceGray':
      return `${n(c.g)} ${OP.strokeGray}`
    case 'DeviceRGB':
      return `${n(c.r)} ${n(c.g)} ${n(c.b)} ${OP.strokeRGB}`
    case 'DeviceCMYK':
      return `${n(c.c)} ${n(c.m)} ${n(c.y)} ${n(c.k)} ${OP.strokeCMYK}`
  }
}
