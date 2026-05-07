import { encrypt } from '@strav/kernel'
import type { ChallengeType } from '../types.ts'
import { DEFAULTS } from '../types.ts'

/**
 * Hashcash-style proof of work. The client must find a nonce such that
 * `sha256(salt + ':' + nonce)` has at least `difficulty` leading zero
 * bits. Verification is a single sha256 — no DB, no chain of trust.
 *
 * The salt IS the challenge — exposed in props so the client can hash
 * against the same value the server will check. No separate `answer`:
 * the proof IS the work, not a secret.
 *
 * Difficulty 18 ≈ 100–500 ms on a modern laptop; halving (16) makes it
 * comfortable on phones, +2 (20) is a noticeable pause.
 */
export const powChallenge: ChallengeType = {
  name: 'pow',
  issue(opts) {
    const difficulty = opts.difficulty ?? DEFAULTS.difficulty
    return {
      props: { challenge: opts.salt, difficulty },
      extra: { d: difficulty },
    }
  },
  verify(payload, response) {
    if (typeof response !== 'string' || response.length === 0) {
      return { ok: false, reason: 'pow_insufficient' }
    }
    const difficulty = payload.d ?? DEFAULTS.difficulty

    // Cap nonce length so a malicious client can't ship megabyte payloads
    // through our hash function.
    if (response.length > 64) return { ok: false, reason: 'pow_insufficient' }

    const digest = encrypt.sha256(payload.s + ':' + response)
    if (countLeadingZeroBits(digest) < difficulty) {
      return { ok: false, reason: 'pow_insufficient' }
    }
    return { ok: true }
  },
}

/**
 * Count leading zero bits in a hex digest. 4 bits per nibble — once we
 * hit a non-zero nibble we add the leading zeros within it and stop.
 */
export function countLeadingZeroBits(hex: string): number {
  let bits = 0
  for (let i = 0; i < hex.length; i++) {
    const nibble = parseInt(hex[i]!, 16)
    if (nibble === 0) {
      bits += 4
      continue
    }
    // Count leading zeros in this nibble (1..3, since nibble != 0)
    if (nibble < 0b0010) bits += 3
    else if (nibble < 0b0100) bits += 2
    else if (nibble < 0b1000) bits += 1
    break
  }
  return bits
}
