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
    const body = await this.body<Record<string, unknown>>()
    const result = {} as Record<K, string>
    const fields = body && typeof body === 'object' ? body : {}
    if (keys.length === 0) {
      for (const [key, value] of Object.entries(fields)) {
        if (typeof value === 'string') (result as Record<string, string>)[key] = value
      }
    } else {
      for (const key of keys) {
        const value = fields[key]
        result[key] = typeof value === 'string' ? value : ''
      }
    }
    return result
  }

  /** Extract named file fields from a form body. With no args, returns all file fields. */
  async files<K extends string>(...keys: K[]): Promise<Record<K, File | null>> {
    const body = await this.body<Record<string, unknown>>()
    const result = {} as Record<K, File | null>
    const fields = body && typeof body === 'object' ? body : {}
    if (keys.length === 0) {
      for (const [key, value] of Object.entries(fields)) {
        if (value instanceof File) (result as Record<string, File>)[key] = value
      }
    } else {
      for (const key of keys) {
        const value = fields[key]
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

  /**
   * Create a Server-Sent Events response.
   *
   * @param generator - Async generator or readable stream that yields SSE events
   * @param options - Optional SSE configuration
   * @returns Response with SSE headers and streaming body
   *
   * @example
   * // With async generator
   * return ctx.sse(async function* () {
   *   yield { event: 'message', data: 'Hello' }
   *   yield { data: { count: 1 } }
   * })
   *
   * @example
   * // With ReadableStream
   * const stream = new ReadableStream({
   *   start(controller) {
   *     controller.enqueue({ event: 'ping', data: 'pong' })
   *   }
   * })
   * return ctx.sse(stream)
   */
  sse(
    source: AsyncGenerator<any, void, unknown> | ReadableStream,
    options?: { cors?: string | string[] }
  ): Response {
    // Build SSE headers
    const headers = new Headers({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    })

    // Add CORS if specified
    const cors = options?.cors ?? this.headers.get('origin') ?? '*'
    if (cors) {
      headers.set('Access-Control-Allow-Origin', Array.isArray(cors) ? cors.join(', ') : cors)
      headers.set('Access-Control-Allow-Credentials', 'true')
    }

    // Format SSE helper
    const formatSSE = (event: any): string => {
      const lines: string[] = []
      if (event.event) lines.push(`event: ${event.event}`)
      if (event.id) lines.push(`id: ${event.id}`)
      if (event.retry) lines.push(`retry: ${event.retry}`)

      const dataStr = typeof event.data === 'string'
        ? event.data
        : JSON.stringify(event.data)

      for (const line of dataStr.split('\n')) {
        lines.push(`data: ${line}`)
      }

      return lines.join('\n') + '\n\n'
    }

    let stream: ReadableStream

    if (source instanceof ReadableStream) {
      // Transform stream to SSE format
      stream = source.pipeThrough(new TransformStream({
        transform(event, controller) {
          const formatted = formatSSE(event)
          controller.enqueue(new TextEncoder().encode(formatted))
        }
      }))
    } else {
      // Convert async generator to SSE stream
      stream = new ReadableStream({
        async start(controller) {
          const encoder = new TextEncoder()
          try {
            for await (const event of source) {
              const formatted = formatSSE(event)
              controller.enqueue(encoder.encode(formatted))
            }
          } catch (error) {
            controller.error(error)
          } finally {
            controller.close()
          }
        }
      })
    }

    return new Response(stream, { headers })
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
