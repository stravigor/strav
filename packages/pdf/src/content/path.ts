/**
 * Current-path state machine (spec §8.4).
 *
 * The builder maintains an explicit path mode. Path-construction operators
 * open a path; a painting/clip/end operator consumes it. Anything that would
 * silently discard an open path (starting a `q`/`Q`/text block, or ending the
 * stream) throws — silent path loss is a classic handwritten-PDF bug.
 */

import { PdfGenError } from '../util/errors.ts'

export type PathMode = 'none' | 'building' | 'clip-pending'

export class PathTracker {
  private mode: PathMode = 'none'

  /** A path-construction operator (m, l, c, v, y, re, h) was issued. */
  open(): void {
    if (this.mode === 'none') this.mode = 'building'
  }

  /** A clipping operator (W/W*) was issued; next paint op consumes the path. */
  markClip(): void {
    if (this.mode === 'none') {
      throw new PdfGenError('PDF_NO_PATH', 'Clip operator with no current path')
    }
    this.mode = 'clip-pending'
  }

  /** A painting/end operator (S, f, B, n, …) consumes the path. */
  consume(): void {
    if (this.mode === 'none') {
      throw new PdfGenError('PDF_NO_PATH', 'Painting operator with no current path')
    }
    this.mode = 'none'
  }

  /** Guard before an operation that must not discard an open path. */
  assertClear(context: string): void {
    if (this.mode !== 'none') {
      throw new PdfGenError(
        'PDF_PATH_NOT_CONSUMED',
        `Unconsumed path before ${context}: paint it (stroke/fill/clip) or call endPath()`
      )
    }
  }

  get isOpen(): boolean {
    return this.mode !== 'none'
  }
}
