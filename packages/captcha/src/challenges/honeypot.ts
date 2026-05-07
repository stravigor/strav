import type { ChallengeType } from '../types.ts'

/**
 * Invisible-field honeypot. The middleware injects a hidden input that
 * humans never see; bots that auto-fill every field on the page will
 * trip it. Free, zero UX, layer it under everything else.
 *
 * The honeypot field name is checked at the middleware layer — this
 * type just establishes the token shape so the protection still
 * surfaces a `pow_insufficient`/`token_*` error path consistent with
 * other types when the form is submitted without a token.
 */
export const honeypotChallenge: ChallengeType = {
  name: 'honeypot',
  issue() {
    return { props: {} }
  },
  // Honeypot's "answer" is the absence of a value in the trap field. The
  // middleware checks `body[honeypotField]` directly before getting here,
  // so by the time we run the body has already passed the trap.
  verify() {
    return { ok: true }
  },
}
