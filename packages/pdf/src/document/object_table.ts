/**
 * Registry of indirect objects (spec §5.2, §3.2).
 *
 * Implements the two-pass model: during the build pass every indirect object
 * is allocated a number (1, 2, 3, …) and its value stored; during the
 * serialize pass the values are emitted in number order and byte offsets
 * recorded. Generation is always 0 in v1 (no incremental updates).
 */

import { PdfGenError } from '../util/errors.ts'
import type { PdfObject, IndirectRef } from '../objects/types.ts'
import { ref } from '../objects/types.ts'

export class ObjectTable {
  /** num → object value. Object 0 is the free-list head, never stored here. */
  private readonly slots = new Map<number, PdfObject>()
  private next = 1

  /** Reserve the next object number without assigning a value yet. */
  allocate(): IndirectRef {
    const num = this.next++
    return ref(num, 0)
  }

  /** Assign (or replace) the value for a previously allocated number. */
  set(r: IndirectRef, value: PdfObject): void {
    if (r.num <= 0 || r.num >= this.next) {
      throw new PdfGenError('PDF_INVALID_OBJECT', `Object ${r.num} was not allocated`)
    }
    this.slots.set(r.num, value)
  }

  /** Allocate + assign in one step; returns the reference. */
  add(value: PdfObject): IndirectRef {
    const r = this.allocate()
    this.slots.set(r.num, value)
    return r
  }

  get(num: number): PdfObject | undefined {
    return this.slots.get(num)
  }

  /** Highest allocated object number (0 if none). */
  get maxNumber(): number {
    return this.next - 1
  }

  /** Total slot count including object 0 (the `/Size` trailer value). */
  get size(): number {
    return this.next
  }

  /** Iterate assigned objects in ascending number order. */
  *entries(): IterableIterator<[number, PdfObject]> {
    for (let n = 1; n < this.next; n++) {
      const v = this.slots.get(n)
      if (v === undefined) {
        throw new PdfGenError(
          'PDF_INVALID_OBJECT',
          `Object ${n} was allocated but never assigned a value`
        )
      }
      yield [n, v]
    }
  }
}
