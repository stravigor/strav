/**
 * Text object — the `BT … ET` block (spec §8, §10.7). Created by
 * `ContentStream.text(cb)`; the callback drives it fluently. A font must be
 * set before any `show`; the builder enforces BT/ET-only text operators and
 * (via ContentStream) that no path is open and blocks don't nest.
 */

import { PdfGenError } from '../util/errors.ts'
import { formatNumber } from '../objects/number.ts'
import { encodeLiteral } from '../objects/string.ts'
import type { PdfFont } from '../fonts/font.ts'
import type { ResourceCollector } from './resources.ts'

function n(v: number): string {
  return formatNumber(v)
}

/** A literal PDF string token built from already-encoded font bytes. */
function strToken(bytes: Uint8Array): string {
  // encodeLiteral octal-escapes everything outside printable ASCII, so the
  // result is pure ASCII; map bytes straight to chars (no TextDecoder).
  const lit = encodeLiteral(bytes)
  let s = ''
  for (let i = 0; i < lit.length; i++) s += String.fromCharCode(lit[i]!)
  return s
}

/** A segment of a positioned run for `showRun` (spec §10.7). */
export type RunPart = { text: string } | { adjust: number }

export class TextObject {
  private font?: PdfFont

  constructor(
    private readonly emit: (line: string) => void,
    private readonly resources: ResourceCollector
  ) {}

  /** Select a font at `sizePt` points. */
  setFont(font: PdfFont, sizePt: number): this {
    this.font = font
    const resName = this.resources.useFont(font)
    this.emit(`/${resName} ${n(sizePt)} Tf`)
    return this
  }

  /**
   * Set the **absolute** text position in user space (`1 0 0 1 x y Tm`).
   * This resets the text matrix, so successive calls position independently —
   * unlike `Td`, which is relative to the current line.
   */
  moveTo(x: number, y: number): this {
    this.emit(`1 0 0 1 ${n(x)} ${n(y)} Tm`)
    return this
  }

  /** Set the full text matrix (`a b c d e f Tm`) for scale/rotate/skew. */
  setTextMatrix(a: number, b: number, c: number, d: number, e: number, f: number): this {
    this.emit(`${n(a)} ${n(b)} ${n(c)} ${n(d)} ${n(e)} ${n(f)} Tm`)
    return this
  }

  /** Move to the next line, offset `(tx, ty)` from the current line (`Td`). */
  nextLine(tx: number, ty: number): this {
    this.emit(`${n(tx)} ${n(ty)} Td`)
    return this
  }

  setLeading(leading: number): this {
    this.emit(`${n(leading)} TL`)
    return this
  }

  /** Move to the next line using the current leading (`T*`). */
  newLine(): this {
    this.emit('T*')
    return this
  }

  setCharSpacing(v: number): this {
    this.emit(`${n(v)} Tc`)
    return this
  }

  setWordSpacing(v: number): this {
    this.emit(`${n(v)} Tw`)
    return this
  }

  /** Horizontal scaling as a percentage (`p Tz`). */
  setHorizScale(percent: number): this {
    this.emit(`${n(percent)} Tz`)
    return this
  }

  setRise(v: number): this {
    this.emit(`${n(v)} Ts`)
    return this
  }

  /** Text render mode 0–7 (`m Tr`). */
  setRenderMode(mode: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7): this {
    this.emit(`${mode} Tr`)
    return this
  }

  private requireFont(): PdfFont {
    if (!this.font) {
      throw new PdfGenError('PDF_NO_FONT', 'setFont() must be called before show()/showRun()')
    }
    return this.font
  }

  /** Show a string (`(...) Tj`). */
  show(text: string): this {
    const font = this.requireFont()
    this.emit(`${strToken(font.encode(text))} Tj`)
    return this
  }

  /**
   * Show a positioned run (`[ ... ] TJ`). `adjust` is in 1/1000 em and is
   * subtracted from the current position (spec §10.7).
   */
  showRun(parts: RunPart[]): this {
    const font = this.requireFont()
    const items: string[] = []
    for (const part of parts) {
      if ('text' in part) items.push(strToken(font.encode(part.text)))
      else items.push(n(part.adjust))
    }
    this.emit(`[${items.join(' ')}] TJ`)
    return this
  }

  /** Move to the next line and show (`T*` then `Tj`); needs leading set. */
  newLineShow(text: string): this {
    return this.newLine().show(text)
  }
}
