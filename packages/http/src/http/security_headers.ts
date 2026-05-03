import type { Middleware } from './middleware.ts'

export interface SecurityHeadersHstsOptions {
  /** `max-age` in seconds. Default: 31536000 (1 year). */
  maxAge?: number
  /** Include `includeSubDomains` directive. Default: true. */
  includeSubDomains?: boolean
  /** Include `preload` directive (for HSTS preload-list submission). Default: false. */
  preload?: boolean
}

export interface SecurityHeadersOptions {
  /**
   * `X-Content-Type-Options: nosniff` — prevents the browser from MIME-sniffing
   * a response away from the declared `Content-Type`. Default: `true`. Set
   * `false` to suppress.
   */
  contentTypeOptions?: boolean
  /**
   * `X-Frame-Options` — controls whether the page can be rendered in a
   * frame. Default: `'SAMEORIGIN'`. Use `'DENY'` for stricter sites,
   * `false` to omit, or pass a string for a custom value.
   */
  frameOptions?: 'DENY' | 'SAMEORIGIN' | false | string
  /**
   * `Referrer-Policy` — controls how much referrer info is sent.
   * Default: `'strict-origin-when-cross-origin'`. Pass `false` to omit.
   */
  referrerPolicy?: string | false
  /**
   * `Strict-Transport-Security` (HSTS) — tells browsers to only contact
   * the site over HTTPS. **Default: `false` (off).** HSTS is unsafe to
   * apply on non-HTTPS deployments — opt in explicitly for production.
   * `true` uses safe defaults; an object lets you tune `maxAge` /
   * `includeSubDomains` / `preload`.
   */
  hsts?: boolean | SecurityHeadersHstsOptions
  /**
   * `Cross-Origin-Opener-Policy` — isolates the browsing context.
   * Default: `'same-origin'`. Pass `false` to omit.
   */
  crossOriginOpenerPolicy?: string | false
  /**
   * `Content-Security-Policy` — full policy string. **Default: `false`
   * (off).** CSP is highly app-specific; enabling it without a tested
   * policy will break your site. A minimal starter policy that ships
   * little risk:
   * ```
   * default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'
   * ```
   * Tighten incrementally; use `Content-Security-Policy-Report-Only`
   * for staged rollout (pass the report header via your reverse proxy
   * or a custom middleware).
   */
  csp?: string | false
}

/**
 * Middleware that sets defense-in-depth response headers. Compose it
 * once at the app entry and every response inherits the protections.
 *
 * @example
 * router.use(securityHeaders())
 *
 * // Tighten frame-options + enable HSTS for prod
 * router.use(securityHeaders({
 *   frameOptions: 'DENY',
 *   hsts: { maxAge: 63072000, includeSubDomains: true, preload: true },
 * }))
 *
 * @example
 * // Opt into a custom CSP (test thoroughly before rolling out)
 * router.use(securityHeaders({
 *   csp: "default-src 'self'; script-src 'self' 'nonce-abc123'",
 * }))
 */
export function securityHeaders(options: SecurityHeadersOptions = {}): Middleware {
  const headers: Record<string, string> = {}

  if (options.contentTypeOptions !== false) {
    headers['X-Content-Type-Options'] = 'nosniff'
  }

  const frame = options.frameOptions ?? 'SAMEORIGIN'
  if (frame !== false) {
    headers['X-Frame-Options'] = frame
  }

  const referrer = options.referrerPolicy ?? 'strict-origin-when-cross-origin'
  if (referrer !== false) {
    headers['Referrer-Policy'] = referrer
  }

  const coop = options.crossOriginOpenerPolicy ?? 'same-origin'
  if (coop !== false) {
    headers['Cross-Origin-Opener-Policy'] = coop
  }

  if (options.hsts) {
    const hsts: SecurityHeadersHstsOptions = options.hsts === true ? {} : options.hsts
    const maxAge = hsts.maxAge ?? 31_536_000
    const includeSub = hsts.includeSubDomains !== false
    const parts = [`max-age=${maxAge}`]
    if (includeSub) parts.push('includeSubDomains')
    if (hsts.preload) parts.push('preload')
    headers['Strict-Transport-Security'] = parts.join('; ')
  }

  if (options.csp) {
    headers['Content-Security-Policy'] = options.csp
  }

  return async (_ctx, next) => {
    const response = await next()
    for (const [name, value] of Object.entries(headers)) {
      // Only set if the response didn't already declare the header — this
      // lets per-route handlers override a global policy without fighting
      // the middleware (e.g., a public embed iframe relaxing X-Frame-Options).
      if (!response.headers.has(name)) {
        response.headers.set(name, value)
      }
    }
    return response
  }
}
