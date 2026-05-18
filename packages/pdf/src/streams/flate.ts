/**
 * FlateDecode (spec §7.2). Node/Bun build only — `node:zlib` at level 9 for
 * deterministic output (level affects the byte sequence). No browser fallback
 * (project decision); no PNG/TIFF predictor in v1.
 */

import { deflateSync, inflateSync } from 'node:zlib'

/** Deflate (zlib) encode at level 9. */
export function flateEncode(data: Uint8Array): Uint8Array {
  return new Uint8Array(deflateSync(data, { level: 9 }))
}

/** Inflate — not used in production output; provided for round-trip tests. */
export function flateDecode(data: Uint8Array): Uint8Array {
  return new Uint8Array(inflateSync(data))
}
