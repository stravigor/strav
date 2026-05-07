import type { CacheStore } from '@strav/kernel'
import type { Middleware } from '@strav/http'

/** Built-in challenge type names. Extensible via `registerChallengeType()`. */
export type ChallengeName = 'honeypot' | 'pow' | 'svg' | (string & {})

/**
 * Reasons a CAPTCHA verification can fail. Surfaced to `onFailure` and
 * (when JSON) returned to the client so the form can display targeted help.
 */
export type FailureReason =
  | 'token_missing'
  | 'token_invalid'
  | 'token_expired'
  | 'answer_mismatch'
  | 'replayed'
  | 'honeypot_tripped'
  | 'pow_insufficient'
  | 'unknown_type'

/**
 * Sealed payload carried in the `_captcha` form field. Stateless — the
 * server reconstructs everything from this token at verify time. The salt
 * `s` makes brute-forcing the answer hash impractical even if the seal is
 * cracked; `jti` is the replay cache key so a token can only succeed once.
 */
export interface CaptchaTokenPayload {
  /** Schema version. Bump on breaking changes. */
  v: 1
  /** Challenge type — chooses the verifier. */
  t: ChallengeName
  /** sha256(normalize(answer) + salt) — omitted for honeypot. */
  ah?: string
  /** Random per-challenge salt (hex). Hashed with the answer. */
  s: string
  /** PoW difficulty in leading zero bits. Only set when `t === 'pow'`. */
  d?: number
  /** Issued-at, ms since epoch. */
  iat: number
  /** Expiry duration in minutes. */
  exp: number
  /** Replay cache key — a hex random per challenge. */
  jti: string
}

/** What `issueChallenge()` hands back — token + render data for the form. */
export interface IssuedChallenge {
  /** Sealed token to embed in a hidden form field. */
  token: string
  /** Type-specific data the renderer needs (e.g. `{ challenge, difficulty }`). */
  props: Record<string, unknown>
  /** Optional pre-rendered HTML/SVG (used by `svg`). */
  html?: string
}

/** Options passed to `issueChallenge()`. */
export interface IssueOptions {
  /** Override default expiry. */
  ttlMinutes?: number
  /** PoW only — leading zero bits. */
  difficulty?: number
}

/** Result of `verifyChallenge()`. `ok: true` consumes the replay slot. */
export type VerifyResult =
  | { ok: true; payload: CaptchaTokenPayload }
  | { ok: false; reason: FailureReason }

/**
 * A challenge type plugged into the registry. `verify` receives the
 * decoded payload plus the user's response and the current cache, and
 * returns either ok or a `FailureReason`.
 */
export interface ChallengeType {
  name: ChallengeName
  /**
   * Build a fresh challenge. Returns the props the renderer needs and the
   * data that gets sealed into the token (answer hash + any type-specific
   * extras like PoW difficulty). Receives the per-challenge salt so types
   * like PoW can expose it to the client as the challenge value (PoW
   * verifies `sha256(payload.s + ':' + nonce)` so client and server need
   * to agree on the salt).
   */
  issue(opts: IssueOptions & { salt: string }): {
    props: Record<string, unknown>
    /** Extra fields merged into the token payload (e.g. `{ d: difficulty }`). */
    extra?: Partial<Pick<CaptchaTokenPayload, 'd'>>
    /** Plaintext answer the user is expected to produce — hashed with salt before sealing. */
    answer?: string
    /** Optional pre-rendered HTML (e.g. SVG body). */
    html?: string
  }
  /**
   * Verify the response against the sealed payload. Pure function — replay
   * prevention happens upstream, not here.
   */
  verify(
    payload: CaptchaTokenPayload,
    response: unknown,
    body: Record<string, unknown>
  ): { ok: true } | { ok: false; reason: FailureReason }
}

/** Options for the `captcha()` middleware. */
export interface CaptchaOptions {
  /** Challenge types accepted by this guard. @default ['honeypot', 'pow'] */
  types?: ChallengeName[]
  /** Hidden field bots fill in. @default 'website' */
  honeypotField?: string
  /** Form field carrying the sealed token. @default '_captcha' */
  tokenField?: string
  /** Form field carrying the user's answer / nonce. @default '_captcha_answer' */
  responseField?: string
  /** PoW difficulty in leading zero bits. @default 18 */
  difficulty?: number
  /** Token lifetime in minutes. @default 10 */
  ttlMinutes?: number
  /** Skip the guard for matching requests (e.g. internal health checks). */
  skip?: (ctx: Parameters<Middleware>[0]) => boolean
  /** Custom failure response. Falls back to JSON 422 / flash-redirect. */
  onFailure?: (
    ctx: Parameters<Middleware>[0],
    reason: FailureReason
  ) => Response | Promise<Response>
  /** Cache store for replay prevention. Defaults to `CacheManager.store`. */
  store?: CacheStore
}

export const DEFAULTS = {
  honeypotField: 'website',
  tokenField: '_captcha',
  responseField: '_captcha_answer',
  difficulty: 18,
  ttlMinutes: 10,
} as const
