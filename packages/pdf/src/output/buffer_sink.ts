/**
 * A {@link ByteSink} that accumulates everything into a single Uint8Array,
 * returned by `PdfDocument.save()` (spec §3.3).
 *
 * Uses a geometrically-growing backing buffer to keep appends amortized O(1)
 * and peak memory bounded (spec §18.6).
 */

import type { ByteSink } from './byte_sink.ts'

export class BufferSink implements ByteSink {
  private buf: Uint8Array
  private len = 0

  constructor(initialCapacity = 64 * 1024) {
    this.buf = new Uint8Array(initialCapacity)
  }

  get length(): number {
    return this.len
  }

  write(bytes: Uint8Array): void {
    const needed = this.len + bytes.length
    if (needed > this.buf.length) {
      let cap = this.buf.length * 2
      while (cap < needed) cap *= 2
      const next = new Uint8Array(cap)
      next.set(this.buf.subarray(0, this.len))
      this.buf = next
    }
    this.buf.set(bytes, this.len)
    this.len = needed
  }

  /** Return the exact written bytes (a copy sized to `length`). */
  toBytes(): Uint8Array {
    return this.buf.slice(0, this.len)
  }
}
