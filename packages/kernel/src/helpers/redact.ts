/**
 * Default deny-list of object keys whose values should be redacted before
 * the data is written to a log, audit entry, devtools capture, error
 * wrapper, or any other persistent observability surface.
 *
 * Matching is case-insensitive and exact (not substring), so common
 * casing variants are listed explicitly rather than relying on a regex.
 * Add the casing your code actually emits — `extraKeys` is for extending,
 * `keys` for replacing.
 */
const DEFAULT_KEYS: readonly string[] = [
  'password',
  'passwd',
  'pwd',
  'token',
  'access_token',
  'accesstoken',
  'refresh_token',
  'refreshtoken',
  'id_token',
  'idtoken',
  'secret',
  'client_secret',
  'clientsecret',
  'api_key',
  'apikey',
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'x-csrf-token',
  'csrf-token',
  'csrftoken',
  'proxy-authorization',
  'session',
  'session_id',
  'sessionid',
]

export interface RedactOptions {
  /** Additional keys to redact, on top of the default list. Case-insensitive. */
  extraKeys?: readonly string[]
  /** Replace the default list entirely. Case-insensitive. */
  keys?: readonly string[]
  /** Replacement value for redacted strings. Default: `'[REDACTED]'`. */
  replacement?: string
}

/**
 * Return a deep copy of `value` with any string property whose key is in
 * the deny-list replaced by `[REDACTED]`. Walks plain objects and arrays;
 * passes Date, Buffer, typed arrays, and class instances through unchanged.
 *
 * Use this at every observability boundary — log emission, audit append,
 * devtools collect, error wrap — to scrub secrets before they get
 * persisted.
 *
 * @example
 * redact({ headers: { authorization: 'Bearer abc', accept: 'json' } })
 * // → { headers: { authorization: '[REDACTED]', accept: 'json' } }
 */
export function redact<T>(value: T, options: RedactOptions = {}): T {
  const replacement = options.replacement ?? '[REDACTED]'
  const baseKeys = options.keys ?? DEFAULT_KEYS
  const denyList = new Set<string>()
  for (const k of baseKeys) denyList.add(k.toLowerCase())
  if (options.extraKeys) for (const k of options.extraKeys) denyList.add(k.toLowerCase())

  return walk(value, denyList, replacement) as T
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

function walk(v: unknown, denyList: Set<string>, replacement: string): unknown {
  if (v === null || v === undefined) return v
  if (Array.isArray(v)) return v.map(item => walk(item, denyList, replacement))
  if (!isPlainObject(v)) return v // Date, Buffer, typed arrays, class instances, primitives

  const out: Record<string, unknown> = {}
  for (const [key, val] of Object.entries(v)) {
    if (denyList.has(key.toLowerCase()) && val !== null && val !== undefined) {
      out[key] = replacement
    } else {
      out[key] = walk(val, denyList, replacement)
    }
  }
  return out
}

/** The default deny-list, exported for callers that need to inspect or extend it. */
export const defaultRedactKeys: readonly string[] = DEFAULT_KEYS
