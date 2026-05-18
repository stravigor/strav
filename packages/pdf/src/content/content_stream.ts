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
import type { ObjectTable } from '../document/object_table.ts'
import type { Color } from '../color/color.ts'
import type { PdfFont } from '../fonts/font.ts'
import type { PdfImage } from '../images/image.ts'
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
import { ResourceCollector } from './resources.ts'
import { TextObject } from './text_object.ts'

function n(v: number): string {
  return formatNumber(v)
}

export class ContentStream {
  private readonly lines: string[] = []
  private readonly stack: GraphicsState[] = []
  private state: GraphicsState = initialState()
  private readonly path = new PathTracker()
  private readonly resources = new ResourceCollector()
  private inText = false

  private emit(line: string): this {
    this.lines.push(line)
    return this
  }

  /** Reject graphics/path operators that are illegal inside a BT…ET block. */
  private assertNotInText(op: string): void {
    if (this.inText) {
      throw new PdfGenError(
        'PDF_TEXT_STATE',
        `${op} is not allowed inside a text() block (BT…ET)`
      )
    }
  }

  // ── Graphics state ──────────────────────────────────────────────────────

  save(): this {
    this.assertNotInText('q (save)')
    this.path.assertClear('q (save)')
    this.stack.push(cloneState(this.state))
    return this.emit(OP.save)
  }

  restore(): this {
    this.assertNotInText('Q (restore)')
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
    this.assertNotInText('cm (transform)')
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
    this.assertNotInText('m (moveTo)')
    this.path.open()
    return this.emit(`${n(x)} ${n(y)} ${OP.moveTo}`)
  }

  lineTo(x: number, y: number): this {
    this.assertNotInText('l (lineTo)')
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
    this.assertNotInText('c (curveTo)')
    this.path.open()
    return this.emit(
      `${n(x1)} ${n(y1)} ${n(x2)} ${n(y2)} ${n(x3)} ${n(y3)} ${OP.curveTo}`
    )
  }

  rect(x: number, y: number, w: number, h: number): this {
    this.assertNotInText('re (rect)')
    this.path.open()
    return this.emit(`${n(x)} ${n(y)} ${n(w)} ${n(h)} ${OP.rect}`)
  }

  closePath(): this {
    this.assertNotInText('h (closePath)')
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

  // ── Images (spec §11.3) ─────────────────────────────────────────────────

  /**
   * Draw an image into the rectangle `(x, y)`–`(x+width, y+height)` in user
   * space. The image's pixel dimensions are preserved in the XObject; the
   * rectangle just sets the CTM scale. Emits `q  w 0 0 h x y cm  /Im Do  Q`.
   */
  drawImage(
    image: PdfImage,
    rect: { x: number; y: number; width: number; height: number }
  ): this {
    this.assertNotInText('Do (drawImage)')
    this.path.assertClear('Do (drawImage)')
    const resName = this.resources.useImage(image)
    this.emit(OP.save)
    this.emit(`${n(rect.width)} 0 0 ${n(rect.height)} ${n(rect.x)} ${n(rect.y)} ${OP.cm}`)
    this.emit(`/${resName} ${OP.xobject}`)
    return this.emit(OP.restore)
  }

  // ── Text (spec §8, §10.7) ───────────────────────────────────────────────

  /**
   * A text object: emits `BT`, runs `cb` with a {@link TextObject}, emits `ET`.
   * Blocks must not nest and no path may be open (mirrors the q/Q guard).
   */
  text(cb: (t: TextObject) => void): this {
    this.assertNotInText('BT (text block)')
    this.path.assertClear('BT (text block)')
    this.inText = true
    this.emit(OP.beginText)
    try {
      cb(new TextObject(line => this.emit(line), this.resources))
    } finally {
      // Always close the block, even if the callback threw, so the stream
      // can never be left structurally unbalanced (BT without ET).
      this.inText = false
      this.emit(OP.endText)
    }
    return this
  }

  // ── Finalization ────────────────────────────────────────────────────────

  /** Throws on unbalanced q/Q, an open text block, or an unconsumed path. */
  assertBalanced(): void {
    if (this.inText) {
      throw new PdfGenError('PDF_TEXT_STATE', 'text() block did not close (missing ET)')
    }
    this.path.assertClear('end of content stream')
    if (this.stack.length !== 0) {
      throw new PdfGenError(
        'PDF_UNBALANCED_GRAPHICS_STATE',
        `${this.stack.length} unmatched save() call(s) at end of content stream`
      )
    }
  }

  /** Fonts referenced by this stream, in first-use order. */
  usedFonts(): PdfFont[] {
    return this.resources.usedFonts().map(f => f.font)
  }

  /**
   * Build the page `/Resources` dictionary. Font objects are added to the
   * object table here and referenced by their stable resource names.
   */
  buildResources(table: ObjectTable): PdfDictionary {
    if (this.resources.isEmpty) return dict({})
    const res = dict({})
    const fonts = this.resources.usedFonts()
    if (fonts.length) {
      const fontDict = dict({})
      for (const { name: resName, font } of fonts) {
        fontDict.entries.set(resName, font.register(table))
      }
      res.entries.set('Font', fontDict)
    }
    const images = this.resources.usedImages()
    if (images.length) {
      const xobjDict = dict({})
      for (const { name: resName, image } of images) {
        xobjDict.entries.set(resName, image.register(table))
      }
      res.entries.set('XObject', xobjDict)
    }
    return res
  }

  /** Raw, unfiltered content-stream bytes (filtering happens in the stream). */
  toBytes(): Uint8Array {
    return ascii(this.lines.length ? this.lines.join('\n') + '\n' : '')
  }
}
