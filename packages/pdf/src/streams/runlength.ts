/**
 * RunLengthDecode (spec §7.4.5). Length byte L:
 *   0–127  → copy the next L+1 bytes literally
 *   129–255→ repeat the next single byte 257−L times
 *   128    → EOD
 *
 * Decode-only — the writer never emits RunLength.
 */

export function runLengthDecode(data: Uint8Array): Uint8Array {
  const out: number[] = []
  let i = 0
  while (i < data.length) {
    const len = data[i++]!
    if (len === 128) break // EOD
    if (len < 128) {
      for (let k = 0; k <= len && i < data.length; k++) out.push(data[i++]!)
    } else {
      if (i >= data.length) break
      const b = data[i++]!
      for (let k = 0; k < 257 - len; k++) out.push(b)
    }
  }
  return Uint8Array.from(out)
}
