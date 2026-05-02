import AuditManager, { hashFor } from './audit_manager.ts'
import type { AuditChainResult } from './types.ts'

/**
 * Walk the audit log in chronological order and verify each row's HMAC
 * against the recomputed value. The chain is broken if any row's stored
 * `hash` does not match `HMAC(prev_hash || canonical(row))`, or if a row's
 * `prev_hash` does not match the previous row's `hash`.
 *
 * Returns `{ ok: true, checked }` when verification passes; otherwise
 * `{ ok: false, brokenAt, checked }` with the id of the first broken row.
 */
export async function verifyChain(opts?: {
  from?: number
  to?: number
}): Promise<AuditChainResult> {
  let prevHash: string | null = null
  let prevId: number | undefined
  let checked = 0

  for await (const event of AuditManager.store.walk(opts)) {
    checked++

    // First iteration anchors prevHash to whatever the row says.
    // Subsequent rows must reference the previous row's hash.
    if (prevId !== undefined && (event.prevHash ?? null) !== prevHash) {
      return { ok: false, brokenAt: event.id ?? -1, checked }
    }

    const expected = hashFor(event, event.prevHash ?? null)
    if (event.hash !== expected) {
      return { ok: false, brokenAt: event.id ?? -1, checked }
    }

    prevHash = event.hash ?? null
    prevId = event.id
  }

  return { ok: true, checked }
}
