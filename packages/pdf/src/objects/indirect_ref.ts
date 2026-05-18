/**
 * Indirect reference helpers (spec §5.2). The {@link IndirectRef} type itself
 * lives in objects/types.ts; this module holds formatting used by both the
 * object encoder and the xref writer.
 */

import type { IndirectRef } from './types.ts'

/** `"<num> <gen> R"` — the in-body reference token. */
export function refToken(r: IndirectRef): string {
  return `${r.num} ${r.gen} R`
}

/** `"<num> <gen> obj"` — the indirect object definition header. */
export function objHeader(num: number, gen: number): string {
  return `${num} ${gen} obj`
}
