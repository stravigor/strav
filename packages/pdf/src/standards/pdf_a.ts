/**
 * PDF/A-2b conformance checks (spec §15.1). Returns the list of violations
 * (empty = conforms). Font rules — all fonts embedded, ToUnicode present, no
 * Standard-14 — are enforced earlier: a Standard-14 font under a conformance
 * mode throws `UnsupportedFontError`, and embedded fonts always carry a
 * ToUnicode CMap and are subsetted, so they need no check here.
 *
 * Not checked (out of scope / not producible by this library): encryption,
 * LZWDecode, JavaScript, external references — none are ever emitted.
 */

import type { ConformanceContext } from './context.ts'

export function validatePdfA(ctx: ConformanceContext): string[] {
  const v: string[] = []
  if (!ctx.outputIntent.present) {
    v.push(
      'PDF/A-2b requires an OutputIntent (the all-DeviceGray exception is not ' +
        'auto-detected — call setOutputIntent)'
    )
  }
  return v
}
