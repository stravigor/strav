import { ViewEngine } from '@strav/view'
import { issueChallenge } from './challenges.ts'
import { DEFAULTS } from './types.ts'

/**
 * Default field names. Kept on the helper itself so a single config
 * point flows into both middleware and template rendering — change
 * these and `@captcha` re-emits matching field names automatically.
 */
const config = {
  honeypotField: DEFAULTS.honeypotField,
  tokenField: DEFAULTS.tokenField,
  responseField: DEFAULTS.responseField,
  difficulty: DEFAULTS.difficulty,
  ttlMinutes: DEFAULTS.ttlMinutes,
}

/**
 * Optionally configure helper-side defaults so the markup matches the
 * server-side `captcha()` middleware options. Required only when an app
 * customizes field names — defaults match middleware defaults.
 *
 * @example
 * configureCaptchaHelper({ honeypotField: 'phone_number' })
 */
export function configureCaptchaHelper(opts: Partial<typeof config>): void {
  Object.assign(config, opts)
}

/**
 * Render the form fragment for a challenge. Returns ready-to-emit HTML
 * including the honeypot, the hidden token, and (for visible types) the
 * answer input + island/SVG.
 *
 * Synchronous: `issueChallenge` is sync, the renderer just concatenates
 * strings — safe to call from inside the template render loop.
 */
export function captchaHelper(variant?: string): string {
  const honeypot = renderHoneypot()

  if (!variant || variant === 'honeypot') return honeypot

  if (variant === 'pow') {
    const issued = issueChallenge('pow', { difficulty: config.difficulty, ttlMinutes: config.ttlMinutes })
    const props = JSON.stringify({
      ...issued.props,
      tokenField: config.tokenField,
      responseField: config.responseField,
    }).replace(/'/g, '&#39;')
    return (
      honeypot +
      `<input type="hidden" name="${attr(config.tokenField)}" value="${attr(issued.token)}">` +
      `<input type="hidden" name="${attr(config.responseField)}" value="">` +
      `<div data-vue="captcha/pow" data-props='${props}'></div>`
    )
  }

  if (variant === 'svg') {
    const issued = issueChallenge('svg', { ttlMinutes: config.ttlMinutes })
    const refreshProps = JSON.stringify({ tokenField: config.tokenField }).replace(/'/g, '&#39;')
    return (
      honeypot +
      `<input type="hidden" name="${attr(config.tokenField)}" value="${attr(issued.token)}">` +
      `<div class="captcha-svg">` +
      (issued.html ?? '') +
      // Sibling-not-child: the Vue island replaces this element's content,
      // but the SVG above stays untouched until the user clicks refresh.
      `<span data-vue="captcha/refresh" data-props='${refreshProps}'></span>` +
      `</div>` +
      `<input type="text" name="${attr(config.responseField)}" autocomplete="off" ` +
      `inputmode="latin" autocapitalize="characters" required aria-label="Type the characters shown">`
    )
  }

  throw new Error(`@captcha: unknown variant "${variant}" (expected 'pow' | 'svg' | 'honeypot' or none)`)
}

function renderHoneypot(): string {
  const name = attr(config.honeypotField)
  // Triple defense: aria-hidden, tabindex=-1, off-screen via inline style.
  // Don't use `display:none` — some bots skip those fields.
  return (
    `<div aria-hidden="true" style="position:absolute;left:-9999px;top:auto;width:1px;height:1px;overflow:hidden">` +
    `<label for="${name}">Leave this field empty</label>` +
    `<input type="text" id="${name}" name="${name}" tabindex="-1" autocomplete="off" value="">` +
    `</div>`
  )
}

function attr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

/**
 * Wire `__captcha(variant)` into the view engine so `@captcha` works.
 * Call once at boot, after ViewEngine is constructed.
 *
 * @example
 * import { installCaptchaHelpers } from '@strav/captcha'
 * // …after ViewEngine is registered in the container
 * installCaptchaHelpers()
 */
export function installCaptchaHelpers(): void {
  ViewEngine.setGlobal('__captcha', captchaHelper)
}
