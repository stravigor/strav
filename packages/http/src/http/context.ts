import { parseCookies } from './cookie.ts'
// ViewEngine interface - concrete implementation provided by @strav/view
interface ViewEngine {
  render(template: string, data?: Record<string, unknown>): Promise<string>
}
import { ConfigurationError } from '@strav/kernel/exceptions/errors'

/**
 * HTTP request context — the primary object handlers interact with.
 *
 * Wraps Bun's native Request and adds route params, body parsing,
 * response helpers, and a type-safe state bag for middleware.
 */
export default class Context {
  private static _viewEngine: ViewEngine | null = null

  static setViewEngine(engine: ViewEngine): void {
    Context._viewEngine = engine
  }

  readonly url: URL
  readonly method: string
  readonly path: string
  readonly headers: Headers

  private _state = new Map<string, unknown>()
  private _subdomain?: string
  private _query?: URLSearchParams
  private _cookies?: Map<string, string>
  private _body?: unknown
  private _bodyParsed = false

  constructor(
    readonly request: Request,
    readonly params: Record<string, string> = {},
    private domain: string = 'localhost'
  ) {
    this.url = new URL(request.url)
    this.method = request.method
    this.path = this.url.pathname
    this.headers = request.headers
  }

  // ---------------------------------------------------------------------------
  // Request helpers
  // ---------------------------------------------------------------------------

  /** Parsed query string parameters. */
  get query(): URLSearchParams {
    if (!this._query) this._query = this.url.searchParams
    return this._query
  }

  /** Subdomain extracted from the Host header relative to the configured domain. */
  get subdomain(): string {
    if (this._subdomain !== undefined) return this._subdomain

    const host = this.headers.get('host') ?? ''
    const hostname = host.split(':')[0] ?? ''

    if (hostname.endsWith(this.domain) && hostname.length > this.domain.length) {
      this._subdomain = hostname.slice(0, -(this.domain.length + 1))
    } else {
      this._subdomain = ''
    }

    return this._subdomain
  }

  /**
   * Get the full origin (protocol + host) of the current request.
   * Uses the X-Forwarded-Proto header if present (common behind proxies),
   * otherwise determines from the request URL.
   */
  getOrigin(): string {
    // Check for forwarded protocol (when behind proxy/load balancer)
    const forwardedProto = this.headers.get('x-forwarded-proto')
    const protocol = forwardedProto ? `${forwardedProto}:` : this.url.protocol

    // Get host from header (includes port if non-standard)
    const host = this.headers.get('host') || this.url.host

    return `${protocol}//${host}`
  }

  /** Shorthand for reading a single request header. */
  header(name: string): string | null {
    return this.headers.get(name)
  }

  /** Read a query string parameter, with optional typed default. */
  qs(name: string): string | null
  qs(name: string, defaultValue: number): number
  qs(name: string, defaultValue: string): string
  qs(name: string, defaultValue?: string | number): string | number | null {
    const value = this.query.get(name)
    if (value === null || value === '') return defaultValue ?? null
    if (typeof defaultValue === 'number') {
      const parsed = Number(value)
      return Number.isNaN(parsed) ? defaultValue : parsed
    }
    return value
  }

  /** Read a cookie value by name from the Cookie header. */
  cookie(name: string): string | null {
    if (!this._cookies) {
      this._cookies = parseCookies(this.headers.get('cookie') ?? '')
    }
    return this._cookies.get(name) ?? null
  }

  /** Extract named string fields from a form body. With no args, returns all non-file fields. */
  async inputs<K extends string>(...keys: K[]): Promise<Record<K, string>> {
    const form = await this.body<FormData>()
    const result = {} as Record<K, string>
    if (keys.length === 0) {
      form.forEach((value, key) => {
        if (typeof value === 'string') (result as Record<string, string>)[key] = value
      })
    } else {
      for (const key of keys) {
        const value = form.get(key)
        result[key] = typeof value === 'string' ? value : ''
      }
    }
    return result
  }

  /** Extract named file fields from a form body. With no args, returns all file fields. */
  async files<K extends string>(...keys: K[]): Promise<Record<K, File | null>> {
    const form = await this.body<FormData>()
    const result = {} as Record<K, File | null>
    if (keys.length === 0) {
      form.forEach((value, key) => {
        if (value instanceof File) (result as Record<string, File>)[key] = value
      })
    } else {
      for (const key of keys) {
        const value = form.get(key)
        result[key] = value instanceof File ? value : null
      }
    }
    return result
  }

  /**
   * Parse the request body. Automatically detects JSON, form-data, and text.
   * The result is cached — safe to call multiple times.
   */
  async body<T = unknown>(): Promise<T> {
    if (!this._bodyParsed) {
      const contentType = this.header('content-type') ?? ''

      if (contentType.includes('application/json')) {
        this._body = await this.request.json()
      } else if (
        contentType.includes('multipart/form-data') ||
        contentType.includes('application/x-www-form-urlencoded')
      ) {
        const formData = await this.request.formData()
        const obj: Record<string, unknown> = {}
        formData.forEach((value, key) => {
          obj[key] = value
        })
        this._body = obj
      } else {
        this._body = await this.request.text()
      }

      this._bodyParsed = true
    }

    return this._body as T
  }

  // ---------------------------------------------------------------------------
  // Response helpers
  // ---------------------------------------------------------------------------

  json(data: unknown, status = 200): Response {
    return new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  text(content: string, status = 200): Response {
    return new Response(content, {
      status,
      headers: { 'Content-Type': 'text/plain' },
    })
  }

  html(content: string, status = 200): Response {
    return new Response(content, {
      status,
      headers: { 'Content-Type': 'text/html' },
    })
  }

  redirect(url: string, status = 302): Response {
    return new Response(null, {
      status,
      headers: { Location: url },
    })
  }

  empty(status = 204): Response {
    return new Response(null, { status })
  }

  async view(template: string, data?: Record<string, unknown>, status = 200): Promise<Response> {
    if (!Context._viewEngine) {
      throw new ConfigurationError('ViewEngine not configured. Register it in the container.')
    }
    const html = await Context._viewEngine.render(template, data)
    return this.html(html, status)
  }

  // ---------------------------------------------------------------------------
  // Middleware state
  // ---------------------------------------------------------------------------

  /** Store a value for downstream middleware / handlers. */
  set<T>(key: string, value: T): void {
    this._state.set(key, value)
  }

  /** Retrieve a value set by upstream middleware. */
  get<T>(key: string): T
  get<T1, T2>(k1: string, k2: string): [T1, T2]
  get<T1, T2, T3>(k1: string, k2: string, k3: string): [T1, T2, T3]
  get<T1, T2, T3, T4>(k1: string, k2: string, k3: string, k4: string): [T1, T2, T3, T4]
  get(...keys: string[]): unknown {
    if (keys.length === 1) return this._state.get(keys[0]!)
    return keys.map(k => this._state.get(k))
  }
}
