import { encrypt } from '@strav/kernel'
import type { CacheStore } from '@strav/kernel'
import type { CaptchaTokenPayload, FailureReason } from './types.ts'

const REPLAY_PREFIX = 'captcha:used:'

/**
 * Hash an answer with its per-challenge salt. The salt prevents a global
 * rainbow-table on common SVG answers (`abcd12`, `1234`, …) and ensures
 * two challenges with the same plaintext answer produce different hashes.
 *
 * Lowercase + trim is the canonical normalization — matches what the
 * SVG/math verifiers do at compare time.
 */
export function hashAnswer(answer: string, salt: string): string {
  return encrypt.sha256(answer.toLowerCase().trim() + salt)
}

/** Constant-time string equality on hex digests. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}

/**
 * Seal a payload (sets iat/jti automatically). The salt and answer hash
 * must already be in `data` — the caller (`challenges.ts`) computes them
 * because only it knows the challenge type's normalize rules.
 */
export function sealToken(data: Omit<CaptchaTokenPayload, 'v' | 'iat' | 'jti'>): {
  token: string
  payload: CaptchaTokenPayload
} {
  const payload: CaptchaTokenPayload = {
    v: 1,
    iat: Date.now(),
    jti: encrypt.random(16),
    ...data,
  }
  return { token: encrypt.seal(payload), payload }
}

/**
 * Decode a sealed token. Returns the payload, or a failure reason that
 * the verifier can short-circuit on (invalid seal, expired).
 *
 * Replay prevention happens at `consumeReplay()` — splitting the steps
 * lets the verifier check the answer first and only burn the replay slot
 * on success.
 */
export function unsealToken(
  token: string
): { ok: true; payload: CaptchaTokenPayload } | { ok: false; reason: FailureReason } {
  let payload: CaptchaTokenPayload
  try {
    payload = encrypt.unseal<CaptchaTokenPayload>(token)
  } catch {
    return { ok: false, reason: 'token_invalid' }
  }

  if (!payload || payload.v !== 1 || typeof payload.iat !== 'number') {
    return { ok: false, reason: 'token_invalid' }
  }

  if (Date.now() > payload.iat + payload.exp * 60_000) {
    return { ok: false, reason: 'token_expired' }
  }

  return { ok: true, payload }
}

/**
 * Mark a token as used. Returns false if the slot was already taken
 * (replay), true on the first successful use.
 *
 * The cache TTL matches the token's remaining lifetime so we don't keep
 * dead replay keys around. After expiry the token is rejected by
 * `unsealToken` regardless, so no leak.
 */
export async function consumeReplay(
  store: CacheStore,
  payload: CaptchaTokenPayload
): Promise<boolean> {
  const key = REPLAY_PREFIX + payload.jti
  if (await store.has(key)) return false

  const remainingMs = payload.iat + payload.exp * 60_000 - Date.now()
  const ttlSeconds = Math.max(1, Math.ceil(remainingMs / 1000))
  await store.set(key, 1, ttlSeconds)
  return true
}
