import { encrypt } from '@strav/kernel'
import type {
  ChallengeName,
  IssueOptions,
  IssuedChallenge,
  CaptchaTokenPayload,
  VerifyResult,
} from './types.ts'
import { DEFAULTS } from './types.ts'
import { getChallengeType, registerChallengeType } from './registry.ts'
import { sealToken, unsealToken, hashAnswer } from './token.ts'
import { honeypotChallenge } from './challenges/honeypot.ts'
import { powChallenge } from './challenges/pow.ts'
import { svgChallenge } from './challenges/svg.ts'

// Self-register built-ins on first import. Side-effect on import is the
// same pattern the auth/flag drivers use — single source of truth, no
// service-locator wiring required.
registerChallengeType(honeypotChallenge)
registerChallengeType(powChallenge)
registerChallengeType(svgChallenge)

/**
 * Issue a fresh challenge. Synchronous — `encrypt.seal` and the built-in
 * issuers all run without I/O. Caller embeds `token` in a hidden field
 * and uses `props` (and `html` for SVG) to render the challenge.
 */
export function issueChallenge(type: ChallengeName, opts: IssueOptions = {}): IssuedChallenge {
  const challenge = getChallengeType(type)
  if (!challenge) throw new Error(`Unknown captcha challenge type: ${type}`)

  const ttlMinutes = opts.ttlMinutes ?? DEFAULTS.ttlMinutes
  // 16 bytes (32 hex chars) — salts double as the PoW challenge value, so
  // give them enough entropy that a precomputed PoW table is impractical.
  const salt = encrypt.random(16)

  const issued = challenge.issue({
    ...opts,
    difficulty: opts.difficulty ?? DEFAULTS.difficulty,
    salt,
  })

  const tokenData: Omit<CaptchaTokenPayload, 'v' | 'iat' | 'jti'> = {
    t: type,
    s: salt,
    exp: ttlMinutes,
    ...(issued.answer !== undefined ? { ah: hashAnswer(issued.answer, salt) } : {}),
    ...(issued.extra ?? {}),
  }

  const { token } = sealToken(tokenData)

  return {
    token,
    props: issued.props,
    ...(issued.html !== undefined ? { html: issued.html } : {}),
  }
}

/**
 * Decode and verify a token + the user's response. Replay prevention
 * happens upstream in the middleware (after we know verification passed)
 * so that failed attempts don't burn the replay slot.
 *
 * Pure: no cache writes, no I/O. Easy to call from a custom validator
 * or a JSON API handler.
 */
export function verifyChallenge(
  token: string,
  response: unknown,
  body: Record<string, unknown> = {}
): VerifyResult {
  if (!token || typeof token !== 'string') {
    return { ok: false, reason: 'token_missing' }
  }

  const decoded = unsealToken(token)
  if (!decoded.ok) return decoded

  const challenge = getChallengeType(decoded.payload.t)
  if (!challenge) return { ok: false, reason: 'unknown_type' }

  const result = challenge.verify(decoded.payload, response, body)
  if (!result.ok) return result

  return { ok: true, payload: decoded.payload }
}

export { honeypotChallenge, powChallenge, svgChallenge }
