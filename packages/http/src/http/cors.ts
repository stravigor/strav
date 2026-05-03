// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CorsOptions {
  /**
   * Allowed origins. Determines Access-Control-Allow-Origin.
   *
   * - `false` — disable CORS entirely (no headers emitted) — **default**
   * - `'*'` — allow all origins (incompatible with credentials)
   * - `string` — a single exact origin
   * - `string[]` — an allow-list of exact origins
   * - `RegExp` — pattern tested against the request Origin header
   * - `(origin: string) => boolean` — callback for custom logic
   *
   * The default of `false` is deliberately strict — apps must opt-in
   * with an explicit allow-list. Passing `'*'` opens the API to
   * cross-origin reads from any site.
   *
   * @default false
   */
  origin?: false | string | string[] | RegExp | ((origin: string) => boolean)

  /**
   * Allowed HTTP methods for preflight responses.
   * @default ['GET','HEAD','PUT','PATCH','POST','DELETE']
   */
  methods?: string[]

  /**
   * Allowed request headers for preflight responses.
   * When unset, mirrors the Access-Control-Request-Headers from the preflight.
   */
  allowedHeaders?: string[]

  /** Headers exposed to the browser via Access-Control-Expose-Headers. */
  exposedHeaders?: string[]

  /**
   * Include Access-Control-Allow-Credentials: true.
   * When true, origin cannot be literal `'*'` — the actual request origin is reflected.
   * @default false
   */
  credentials?: boolean

  /**
   * Preflight cache duration in seconds (Access-Control-Max-Age).
   * @default 86400
   */
  maxAge?: number
}

/** Resolved config with defaults applied. */
export interface ResolvedCorsConfig {
  origin: false | string | string[] | RegExp | ((origin: string) => boolean)
  methods: string[]
  allowedHeaders?: string[]
  exposedHeaders?: string[]
  credentials: boolean
  maxAge: number
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULTS: ResolvedCorsConfig = {
  // Strict-by-default: refuse all cross-origin requests until the app
  // explicitly opts in with an allow-list. Public APIs that want
  // wide-open CORS must pass `cors({ origin: '*' })`.
  origin: false,
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE'],
  credentials: false,
  maxAge: 86400,
}

/**
 * Real Origin headers are URL-shaped (`scheme://host[:port]`) and
 * comfortably under 253 characters (DNS name max). Anything longer is
 * either malformed or an attacker probing a regex matcher for a ReDoS
 * window — reject before regex/array iteration.
 */
const MAX_ORIGIN_LENGTH = 253

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Merge user options with defaults. */
export function resolveCorsConfig(options?: CorsOptions): ResolvedCorsConfig {
  return { ...DEFAULTS, ...options }
}

/**
 * Determine the Access-Control-Allow-Origin value for a request origin.
 * Returns `null` when the origin is not allowed.
 */
export function resolveOrigin(
  config: ResolvedCorsConfig,
  requestOrigin: string | null
): string | null {
  const { origin, credentials } = config

  // Strict default: CORS is off entirely.
  if (origin === false) return null

  if (!requestOrigin) return credentials ? null : '*'

  // Bound the origin length before any regex/array iteration to defend
  // against ReDoS via pathological inputs.
  if (requestOrigin.length > MAX_ORIGIN_LENGTH) return null

  if (origin === '*') return credentials ? requestOrigin : '*'
  if (typeof origin === 'string') return origin === requestOrigin ? origin : null
  if (Array.isArray(origin)) return origin.includes(requestOrigin) ? requestOrigin : null
  if (origin instanceof RegExp) return origin.test(requestOrigin) ? requestOrigin : null
  if (typeof origin === 'function') return origin(requestOrigin) ? requestOrigin : null

  return null
}

/** Build a 204 preflight response with CORS headers. */
export function preflightResponse(
  config: ResolvedCorsConfig,
  requestOrigin: string | null,
  requestHeaders: string | null
): Response {
  const allowedOrigin = resolveOrigin(config, requestOrigin)

  if (!allowedOrigin) return new Response(null, { status: 204 })

  const headers = new Headers()
  headers.set('Access-Control-Allow-Origin', allowedOrigin)
  headers.set('Access-Control-Allow-Methods', config.methods.join(', '))
  headers.set('Access-Control-Max-Age', String(config.maxAge))

  if (config.credentials) {
    headers.set('Access-Control-Allow-Credentials', 'true')
  }

  if (config.allowedHeaders) {
    headers.set('Access-Control-Allow-Headers', config.allowedHeaders.join(', '))
  } else if (requestHeaders) {
    headers.set('Access-Control-Allow-Headers', requestHeaders)
  }

  if (allowedOrigin !== '*') {
    headers.set('Vary', 'Origin')
  }

  return new Response(null, { status: 204, headers })
}

/** Return a new Response with CORS headers appended. */
export function withCorsHeaders(
  response: Response,
  config: ResolvedCorsConfig,
  requestOrigin: string | null
): Response {
  const allowedOrigin = resolveOrigin(config, requestOrigin)
  if (!allowedOrigin) return response

  const headers = new Headers(response.headers)
  headers.set('Access-Control-Allow-Origin', allowedOrigin)

  if (config.credentials) {
    headers.set('Access-Control-Allow-Credentials', 'true')
  }

  if (config.exposedHeaders?.length) {
    headers.set('Access-Control-Expose-Headers', config.exposedHeaders.join(', '))
  }

  if (allowedOrigin !== '*') {
    const existing = headers.get('Vary')
    if (!existing?.includes('Origin')) {
      headers.set('Vary', existing ? `${existing}, Origin` : 'Origin')
    }
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
