import type { Rule } from '@strav/http'
import { verifyChallenge } from './challenges.ts'

/**
 * Validation rule for handlers that prefer `validate()` integration over
 * the middleware. Bind the user's response (and optionally the full body
 * for honeypot/extension checks) when constructing the rule — closure
 * keeps it per-request, no shared mutable state.
 *
 * NOTE: this rule does not perform replay prevention — `validate()` is
 * sync and has no place to read a cache store. For replay-safe checks
 * use the `captcha()` middleware. The rule fits idempotent endpoints
 * where double-submit is harmless.
 *
 * @example
 * const body = await ctx.body<Record<string, unknown>>()
 * const { errors } = validate(body, {
 *   _captcha: [captchaRule(body._captcha_answer, body)],
 *   email: [required(), email()],
 * })
 */
export function captchaRule(response: unknown, body?: Record<string, unknown>): Rule {
  return {
    name: 'captcha',
    validate(value) {
      const token = typeof value === 'string' ? value : ''
      const result = verifyChallenge(token, response, body ?? {})
      return result.ok ? null : `captcha.${result.reason}`
    },
  }
}
