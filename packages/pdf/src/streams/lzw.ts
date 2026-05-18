/**
 * LZWDecode (spec §7.4.4). Variable-width codes 9–12 bits, MSB-first. Code 256
 * = clear table, 257 = EOD. `earlyChange` (default 1) bumps the code width one
 * code early, matching Adobe's encoder. A predictor may follow (spec §7.4.4.4).
 *
 * Decode-only — the writer never emits LZW.
 */

import { unpredict, type PredictorParams } from './flate.ts'

const CLEAR = 256
const EOD = 257

export function lzwDecode(
  data: Uint8Array,
  params?: PredictorParams & { earlyChange?: number },
): Uint8Array {
  const earlyChange = params?.earlyChange ?? 1
  const out: number[] = []

  let bitBuf = 0
  let bitCnt = 0
  let pos = 0
  const next = (width: number): number => {
    while (bitCnt < width) {
      if (pos >= data.length) return EOD
      bitBuf = (bitBuf << 8) | data[pos++]!
      bitCnt += 8
    }
    bitCnt -= width
    return (bitBuf >> bitCnt) & ((1 << width) - 1)
  }

  let dict: number[][] = []
  let width = 9
  const reset = () => {
    dict = []
    for (let i = 0; i < 256; i++) dict[i] = [i]
    dict[CLEAR] = []
    dict[EOD] = []
    width = 9
  }
  reset()

  let prev: number[] | null = null
  for (;;) {
    const code = next(width)
    if (code === EOD) break
    if (code === CLEAR) {
      reset()
      prev = null
      continue
    }

    let entry: number[]
    if (dict[code]) {
      entry = dict[code]!
    } else if (code === dict.length && prev) {
      entry = [...prev, prev[0]!]
    } else {
      break // corrupt stream — stop gracefully
    }
    for (const b of entry) out.push(b)

    if (prev) {
      dict.push([...prev, entry[0]!])
      if (dict.length + earlyChange >= 1 << width && width < 12) width++
    }
    prev = entry
  }

  const bytes = Uint8Array.from(out)
  return params && (params.predictor ?? 1) > 1 ? unpredict(bytes, params) : bytes
}
