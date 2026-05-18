/**
 * FlateDecode (spec §7.2). Node/Bun build only — `node:zlib` at level 9 for
 * deterministic output (level affects the byte sequence). No browser fallback
 * (project decision).
 *
 * Encoding never applies a predictor. Decoding (read side, M13) supports the
 * PNG (10–15) and TIFF (2) predictors via /DecodeParms (spec §7.4.4.4), which
 * real-world PDFs commonly use for xref and image streams.
 */

import { deflateSync, inflateSync } from 'node:zlib'

/** Predictor parameters from a stream's /DecodeParms (spec §7.4.4.4). */
export interface PredictorParams {
  /** 1 = none, 2 = TIFF, 10–15 = PNG (the exact PNG type is per-row). */
  predictor?: number
  /** Samples per pixel. Default 1. */
  colors?: number
  /** Bits per component. Default 8. */
  bitsPerComponent?: number
  /** Samples per row. Default 1. */
  columns?: number
}

/** Deflate (zlib) encode at level 9. */
export function flateEncode(data: Uint8Array): Uint8Array {
  return new Uint8Array(deflateSync(data, { level: 9 }))
}

/**
 * Inflate, then reverse the predictor if one is configured. Falls back to a
 * raw-deflate retry (`-15` window) for the malformed-zlib-header streams some
 * producers emit.
 */
export function flateDecode(data: Uint8Array, params?: PredictorParams): Uint8Array {
  let out: Uint8Array
  try {
    out = new Uint8Array(inflateSync(data))
  } catch {
    out = new Uint8Array(inflateSync(data, { finishFlush: 2 /* Z_SYNC_FLUSH */ }))
  }
  return params && (params.predictor ?? 1) > 1 ? unpredict(out, params) : out
}

/** Reverse a PNG/TIFF predictor (spec §7.4.4.4). Exported for other filters. */
export function unpredict(data: Uint8Array, params: PredictorParams): Uint8Array {
  const predictor = params.predictor ?? 1
  if (predictor <= 1) return data

  const colors = params.colors ?? 1
  const bpc = params.bitsPerComponent ?? 8
  const columns = params.columns ?? 1
  const bpp = Math.ceil((colors * bpc) / 8) // bytes per pixel (≥1)
  const rowBytes = Math.ceil((colors * bpc * columns) / 8)

  if (predictor === 2) {
    // TIFF predictor 2: horizontal differencing, per-component.
    if (bpc !== 8) return data // sub-byte TIFF predictor: rare, left as-is
    const out = data.slice()
    for (let r = 0; r + rowBytes <= out.length; r += rowBytes) {
      for (let i = bpp; i < rowBytes; i++) {
        out[r + i] = (out[r + i]! + out[r + i - bpp]!) & 0xff
      }
    }
    return out
  }

  // PNG predictors: each row is prefixed by a 1-byte filter type.
  const rows = Math.floor(data.length / (rowBytes + 1))
  const out = new Uint8Array(rows * rowBytes)
  const prev = new Uint8Array(rowBytes)
  let src = 0
  let dst = 0
  for (let r = 0; r < rows; r++) {
    const type = data[src++]!
    const row = data.subarray(src, src + rowBytes)
    src += rowBytes
    for (let i = 0; i < rowBytes; i++) {
      const a = i >= bpp ? out[dst + i - bpp]! : 0 // left
      const b = prev[i]! // up
      const c = i >= bpp ? prev[i - bpp]! : 0 // upper-left
      let v = row[i]!
      switch (type) {
        case 0: break // None
        case 1: v = (v + a) & 0xff; break // Sub
        case 2: v = (v + b) & 0xff; break // Up
        case 3: v = (v + ((a + b) >> 1)) & 0xff; break // Average
        case 4: v = (v + paeth(a, b, c)) & 0xff; break // Paeth
        default: break
      }
      out[dst + i] = v
    }
    prev.set(out.subarray(dst, dst + rowBytes))
    dst += rowBytes
  }
  return out
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}
