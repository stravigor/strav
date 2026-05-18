/**
 * Fluent, chainable content-stream builder (spec §8). Operator order matches
 * call order and numbers use the shared serializer, so output is deterministic
 * (§8.5). Graphics-state balance and current-path consumption are enforced;
 * violations throw at `assertBalanced()` (called from `PdfDocument.save()`).
 */

import { ascii } from '../util/ascii.ts'
import { PdfGenError } from '../util/errors.ts'
import { formatNumber } from '../objects/number.ts'
import { dict } from '../objects/types.ts'
import type { PdfDictionary } from '../objects/types.ts'
import type { Color } from '../color/color.ts'
import { fillColorOp, strokeColorOp } from '../color/device.ts'
import { OP } from './operators.ts'
import {
  type GraphicsState,
  type Matrix,
  cloneState,
  initialState,
  multiply,
} from './graphics_state.ts'
import { PathTracker } from './path.ts'

function n(v: number): string {
  return formatNumber(v)
}

export class ContentStream {
  private readonly lines: string[] = []
  private readonly stack: GraphicsState[] = []
  private state: GraphicsState = initialState()
  private readonly path = new PathTracker()

  private emit(line: string): this {
    this.lines.push(line)
    return this
  }

  // ── Graphics state ──────────────────────────────────────────────────────

  save(): this {
    this.path.assertClear('q (save)')
    this.stack.push(cloneState(this.state))
    return this.emit(OP.save)
  }

  restore(): this {
    this.path.assertClear('Q (restore)')
    const prev = this.stack.pop()
    if (!prev) {
      throw new PdfGenError(
        'PDF_UNBALANCED_GRAPHICS_STATE',
        'restore() with no matching save()'
      )
    }
    this.state = prev
    return this.emit(OP.restore)
  }

  /** Concatenate a matrix to the CTM (`a b c d e f cm`). */
  transform(m: Matrix): this {
    this.state.ctm = multiply(m, this.state.ctm)
    return this.emit(`${m.map(n).join(' ')} ${OP.cm}`)
  }

  translate(tx: number, ty: number): this {
    return this.transform([1, 0, 0, 1, tx, ty])
  }

  scale(sx: number, sy: number): this {
    return this.transform([sx, 0, 0, sy, 0, 0])
  }

  setLineWidth(w: number): this {
    this.state.lineWidth = w
    return this.emit(`${n(w)} ${OP.lineWidth}`)
  }

  setLineCap(cap: 0 | 1 | 2): this {
    this.state.lineCap = cap
    return this.emit(`${cap} ${OP.lineCap}`)
  }

  setLineJoin(join: 0 | 1 | 2): this {
    this.state.lineJoin = join
    return this.emit(`${join} ${OP.lineJoin}`)
  }

  setMiterLimit(limit: number): this {
    this.state.miterLimit = limit
    return this.emit(`${n(limit)} ${OP.miterLimit}`)
  }

  setDash(array: number[], phase = 0): this {
    this.state.dash = { array: [...array], phase }
    return this.emit(`[${array.map(n).join(' ')}] ${n(phase)} ${OP.dash}`)
  }

  // ── Color ───────────────────────────────────────────────────────────────

  setFillColor(c: Color): this {
    this.state.fillColor = c
    return this.emit(fillColorOp(c))
  }

  setStrokeColor(c: Color): this {
    this.state.strokeColor = c
    return this.emit(strokeColorOp(c))
  }

  // ── Path construction ───────────────────────────────────────────────────

  moveTo(x: number, y: number): this {
    this.path.open()
    return this.emit(`${n(x)} ${n(y)} ${OP.moveTo}`)
  }

  lineTo(x: number, y: number): this {
    this.path.open()
    return this.emit(`${n(x)} ${n(y)} ${OP.lineTo}`)
  }

  /** Cubic Bézier with both control points (`x1 y1 x2 y2 x3 y3 c`). */
  curveTo(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    x3: number,
    y3: number
  ): this {
    this.path.open()
    return this.emit(
      `${n(x1)} ${n(y1)} ${n(x2)} ${n(y2)} ${n(x3)} ${n(y3)} ${OP.curveTo}`
    )
  }

  rect(x: number, y: number, w: number, h: number): this {
    this.path.open()
    return this.emit(`${n(x)} ${n(y)} ${n(w)} ${n(h)} ${OP.rect}`)
  }

  closePath(): this {
    this.path.open()
    return this.emit(OP.closePath)
  }

  // ── Clipping ────────────────────────────────────────────────────────────

  clip(): this {
    this.path.markClip()
    return this.emit(OP.clip)
  }

  clipEvenOdd(): this {
    this.path.markClip()
    return this.emit(OP.clipEvenOdd)
  }

  // ── Path painting (each consumes the current path) ──────────────────────

  stroke(): this {
    this.path.consume()
    return this.emit(OP.stroke)
  }

  closeStroke(): this {
    this.path.consume()
    return this.emit(OP.closeStroke)
  }

  fill(): this {
    this.path.consume()
    return this.emit(OP.fill)
  }

  fillEvenOdd(): this {
    this.path.consume()
    return this.emit(OP.fillEvenOdd)
  }

  fillStroke(): this {
    this.path.consume()
    return this.emit(OP.fillStroke)
  }

  closeFillStroke(): this {
    this.path.consume()
    return this.emit(OP.closeFillStroke)
  }

  /** End the path with no fill or stroke (consumes a clip without painting). */
  endPath(): this {
    this.path.consume()
    return this.emit(OP.endPath)
  }

  // ── Finalization ────────────────────────────────────────────────────────

  /** Throws on unbalanced q/Q or an unconsumed path (called from save()). */
  assertBalanced(): void {
    this.path.assertClear('end of content stream')
    if (this.stack.length !== 0) {
      throw new PdfGenError(
        'PDF_UNBALANCED_GRAPHICS_STATE',
        `${this.stack.length} unmatched save() call(s) at end of content stream`
      )
    }
  }

  /**
   * Page resource dictionary for resources referenced by this stream. M1–M3
   * only use device color, which needs no resources, so this is empty.
   */
  buildResources(): PdfDictionary {
    return dict({})
  }

  /** Raw, unfiltered content-stream bytes (filtering happens in the stream). */
  toBytes(): Uint8Array {
    return ascii(this.lines.length ? this.lines.join('\n') + '\n' : '')
  }
}
