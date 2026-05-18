/**
 * Big-endian binary readers and fixed-point helpers.
 *
 * Minimal in M1–M3 (only needed by document ID hashing helpers and future
 * font/image parsers). SFNT/JPEG/PNG parsing in later milestones builds on
 * this without restructuring.
 */

export class BinaryReader {
  private readonly view: DataView
  private offset = 0

  constructor(
    private readonly bytes: Uint8Array,
    offset = 0
  ) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    this.offset = offset
  }

  get position(): number {
    return this.offset
  }

  seek(offset: number): void {
    this.offset = offset
  }

  u8(): number {
    return this.view.getUint8(this.offset++)
  }

  u16(): number {
    const v = this.view.getUint16(this.offset, false)
    this.offset += 2
    return v
  }

  i16(): number {
    const v = this.view.getInt16(this.offset, false)
    this.offset += 2
    return v
  }

  u32(): number {
    const v = this.view.getUint32(this.offset, false)
    this.offset += 4
    return v
  }

  /** Read `n` raw bytes as a subarray (no copy). */
  bytesOf(n: number): Uint8Array {
    const out = this.bytes.subarray(this.offset, this.offset + n)
    this.offset += n
    return out
  }

  get remaining(): number {
    return this.bytes.length - this.offset
  }
}

/** Convert a signed 16.16 fixed-point value to a float. */
export function fixed1616(raw: number): number {
  return raw / 65536
}

/** Convert a signed 2.14 fixed-point value (F2Dot14) to a float. */
export function f2dot14(raw: number): number {
  return (raw << 16) / (1 << 30)
}
