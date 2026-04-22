import type { SQL, ReservedSQL } from 'bun'
import { app, Configuration, ExceptionHandler } from '@strav/kernel'
import { Database, BaseModel } from '@strav/database'
import { Router } from '@strav/http'
import { Factory } from './factory.ts'
import { TestDatabaseManager } from './database_manager.ts'

export interface TestCaseOptions {
  /** Route loader — called during setup to register routes. */
  routes?: () => Promise<unknown>
  /** Boot auth + session tables (default: false). */
  auth?: boolean
  /** Boot view engine (default: false). */
  views?: boolean
  /** Wrap each test in a DB transaction that auto-rollbacks (default: true). */
  transaction?: boolean
  /** User resolver for Auth.useResolver() (required when auth: true). */
  userResolver?: (id: string | number) => Promise<unknown>
  /** Base domain for subdomain extraction (default: 'localhost'). */
  domain?: string
}

/**
 * Boot the app, provide HTTP helpers, and wrap each test in a rolled-back
 * transaction for full isolation.
 *
 * @example
 * import { TestCase, Factory } from '@strav/testing'
 *
 * const t = await TestCase.boot({
 *   auth: true,
 *   domain: 'example.com',
 *   routes: () => import('../start/api_routes'),
 * })
 *
 * describe('Posts', () => {
 *   test('list', async () => {
 *     const user = await UserFactory.create()
 *     await t.actingAs(user)
 *     const res = await t.get('/api/posts')
 *     expect(res.status).toBe(200)
 *   })
 * })
 */
export class TestCase {
  db!: Database
  router!: Router
  config!: Configuration

  private _token: string | null = null
  private _headers: Record<string, string> = {}
  private _originalSql: SQL | null = null
  private _reserved: ReservedSQL | null = null
  private _subdomain: string | null = null
  private _domain: string

  constructor(private options: TestCaseOptions = {}) {
    this._domain = options.domain || 'localhost'
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Boot the app — mirrors index.ts bootstrap, minus Server. Call in beforeAll. */
  async setup(): Promise<void> {
    if (!app.has(Configuration)) app.singleton(Configuration)
    if (!app.has(Router)) app.singleton(Router)

    this.config = app.resolve(Configuration)
    await this.config.load()

    // Use shared database manager to prevent connection closed errors
    const dbManager = TestDatabaseManager.getInstance()
    this.db = await dbManager.getDatabase()

    this.router = app.resolve(Router)
    this.router.setDomain(this._domain)

    // Auth + Session
    if (this.options.auth) {
      const { SessionManager } = await import('@strav/http')
      const { Auth } = await import('@strav/http')
      const { PostgresSessionStore } = await import('@strav/database')

      if (!app.has(SessionManager)) app.singleton(SessionManager)
      if (!app.has(Auth)) app.singleton(Auth)
      if (!app.has(PostgresSessionStore)) app.singleton(PostgresSessionStore)

      app.resolve(SessionManager)
      const sessionStore = app.resolve(PostgresSessionStore)
      SessionManager.useStore(sessionStore)
      await sessionStore.ensureSchema()

      app.resolve(Auth)
      await Auth.ensureTables()

      if (this.options.userResolver) {
        Auth.useResolver(this.options.userResolver)
      }
    }

    // View engine
    if (this.options.views) {
      const { ViewEngine } = await import('@strav/view')
      const { Context } = await import('@strav/http')

      if (!app.has(ViewEngine)) app.singleton(ViewEngine)
      const viewEngine = app.resolve(ViewEngine)
      Context.setViewEngine(viewEngine)
    }

    // Routes
    if (this.options.routes) {
      await this.options.routes()
    }

    // Exception handler (always dev mode in tests)
    const handler = new ExceptionHandler(true)
    this.router.useExceptionHandler(handler)
  }

  /** Close the database connection. Call in afterAll. */
  async teardown(): Promise<void> {
    // Ensure any reserved connection is released first
    if (this._reserved) {
      try {
        await this._reserved`ROLLBACK`
      } catch {
        /* ignore */
      }
      this._reserved.release()
      this._reserved = null
    }

    // Release database reference instead of closing it directly
    // This allows multiple test files to share the same connection
    const dbManager = TestDatabaseManager.getInstance()
    await dbManager.releaseDatabase()
  }

  /** Begin a transaction for test isolation. Call in beforeEach. */
  async beforeEach(): Promise<void> {
    if (this.options.transaction !== false) {
      this._originalSql = this.db.sql
      this._reserved = await this._originalSql.reserve()
      await this._reserved`BEGIN`

      // Monkey-patch Database to use the reserved connection.
      // TypeScript `private` is compile-time only — runtime access works.
      ;(this.db as any).connection = this._reserved
      ;(Database as any)._connection = this._reserved
    }
  }

  /** Rollback the transaction and restore state. Call in afterEach. */
  async afterEach(): Promise<void> {
    if (this._reserved) {
      await this._reserved`ROLLBACK`
      this._reserved.release()

      // Restore original connection
      ;(this.db as any).connection = this._originalSql
      ;(Database as any)._connection = this._originalSql
      this._reserved = null
      this._originalSql = null
    }

    // Clear per-test state
    this._token = null
    this._headers = {}
    this._subdomain = null
  }

  // ---------------------------------------------------------------------------
  // HTTP helpers
  // ---------------------------------------------------------------------------

  /** Send a GET request through the router. */
  get(path: string, headers?: Bun.HeadersInit): Promise<Response> {
    return this.request('GET', path, undefined, headers)
  }

  /** Send a POST request with JSON body through the router. */
  post(path: string, body?: unknown, headers?: Bun.HeadersInit): Promise<Response> {
    return this.request('POST', path, body, headers)
  }

  /** Send a PUT request with JSON body through the router. */
  put(path: string, body?: unknown, headers?: Bun.HeadersInit): Promise<Response> {
    return this.request('PUT', path, body, headers)
  }

  /** Send a PATCH request with JSON body through the router. */
  patch(path: string, body?: unknown, headers?: Bun.HeadersInit): Promise<Response> {
    return this.request('PATCH', path, body, headers)
  }

  /** Send a DELETE request through the router. */
  delete(path: string, headers?: Bun.HeadersInit): Promise<Response> {
    return this.request('DELETE', path, undefined, headers)
  }

  // ---------------------------------------------------------------------------
  // Auth helpers
  // ---------------------------------------------------------------------------

  /**
   * Authenticate as the given user for subsequent requests in this test.
   * Creates a real AccessToken in the database.
   */
  async actingAs(user: unknown, tokenName = 'test-token'): Promise<this> {
    const { AccessToken } = await import('@strav/http')
    const { token } = await AccessToken.create(user, tokenName)
    this._token = token
    return this
  }

  /** Add custom headers to all subsequent requests in this test. */
  withHeaders(headers: Record<string, string>): this {
    Object.assign(this._headers, headers)
    return this
  }

  /** Clear the auth token for the next request. */
  withoutAuth(): this {
    this._token = null
    return this
  }

  /** Set subdomain for subsequent requests in this test. */
  onSubdomain(subdomain: string): this {
    this._subdomain = subdomain
    return this
  }

  /** Clear subdomain for subsequent requests. */
  withoutSubdomain(): this {
    this._subdomain = null
    return this
  }

  // ---------------------------------------------------------------------------
  // Static shorthand
  // ---------------------------------------------------------------------------

  /**
   * Boot the TestCase and register bun:test lifecycle hooks automatically.
   *
   * @example
   * const t = await TestCase.boot({
   *   auth: true,
   *   domain: 'example.com',
   *   routes: () => import('../start/api_routes'),
   * })
   */
  static async boot(options?: TestCaseOptions): Promise<TestCase> {
    const tc = new TestCase(options)
    await tc.setup()

    const { afterAll, beforeEach, afterEach } = await import('bun:test')
    afterAll(() => tc.teardown())
    beforeEach(() => tc.beforeEach())
    afterEach(() => tc.afterEach())

    return tc
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private async request(
    method: string,
    path: string,
    body?: unknown,
    headers?: Bun.HeadersInit
  ): Promise<Response> {
    const merged: Record<string, string> = { ...this._headers }
    if (this._token) merged['Authorization'] = `Bearer ${this._token}`
    if (body !== undefined) merged['Content-Type'] = 'application/json'

    // Set Host header for subdomain routing
    if (this._subdomain) {
      merged['Host'] = `${this._subdomain}.${this._domain}`
    } else {
      merged['Host'] = this._domain
    }

    if (headers) {
      const entries =
        headers instanceof Headers
          ? Object.fromEntries(headers.entries())
          : Array.isArray(headers)
            ? Object.fromEntries(headers)
            : headers
      Object.assign(merged, entries)
    }

    // Use the subdomain in the URL when present for clarity
    const hostname = this._subdomain ? `${this._subdomain}.${this._domain}` : this._domain
    const res = this.router.handle(
      new Request(`http://${hostname}${path}`, {
        method,
        headers: merged,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      })
    )

    return (await res) ?? new Response('Not Found', { status: 404 })
  }
}
