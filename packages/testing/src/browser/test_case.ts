import type { SQL, ReservedSQL } from 'bun'
import { app, Configuration, ExceptionHandler } from '@strav/kernel'
import { Database, BaseModel } from '@strav/database'
import { Router } from '@strav/http'
import type { ServerHandle } from './server_lifecycle.ts'
import { startListener, stopListener } from './server_lifecycle.ts'
import { TestDatabaseManager } from '../database_manager.ts'
import { runFresh } from './db_fresh.ts'
import type {
  Browser,
  BrowserContext,
  Cookie,
  Page,
  Request as PWRequest,
} from 'playwright-core'

export type BrowserName = 'chromium' | 'firefox' | 'webkit'
export type MailMode = 'capture' | 'real'

export interface BrowserTestCaseOptions {
  /** Optional route loader. Called during setup to register routes against the shared Router. */
  routes?: () => Promise<unknown>
  /**
   * Optional bootstrap callback for apps with non-trivial provider stacks.
   * Receives no arguments; runs after Configuration loads but before the
   * server starts listening. Use it to register service providers / routes.
   */
  bootstrap?: () => Promise<void>
  /** Boot Auth + SessionManager + PostgresSessionStore (default: true — most browser tests need sessions). */
  auth?: boolean
  /** Boot ViewEngine (default: false). */
  views?: boolean
  /**
   * Wrap each test in a DB transaction that auto-rollbacks. Default: `false`.
   *
   * Unlike {@link TestCase}, `BrowserTestCase` defaults `transaction` to off
   * because the real HTTP server runs in-process and any multi-request page
   * (a navigation that triggers favicon/static fetches plus session writes)
   * contends for the single reserved connection — the result is pool
   * starvation and timeouts. For per-test DB isolation use `fresh: true`
   * (slower but bulletproof) or design tests to clean up their own state.
   */
  transaction?: boolean
  /** User resolver for Auth.useResolver(). */
  userResolver?: (id: string | number) => Promise<unknown>
  /** Run runFresh() once before setup (drops tables + remigrates). Default: false. */
  fresh?: boolean
  /** Mail behaviour: 'capture' swaps in MemoryMailTransport (default), 'real' leaves the configured driver. */
  mail?: MailMode
  /** Playwright browser. Default: 'chromium'. */
  browser?: BrowserName
  /** Headless mode. Default: true (unless PLAYWRIGHT_HEADLESS=0 is set). */
  headless?: boolean
  /** Slow-motion ms between actions. Default: 0. */
  slowMo?: number
  /** Default action timeout in ms. Default: 5000. */
  timeout?: number
  /** Override the listening port. Default: 0 (ephemeral). */
  port?: number
  /** Override the listening hostname. Default: '127.0.0.1'. */
  hostname?: string
}

type Matcher = string | RegExp | { gt?: string | number; lt?: string | number; eq?: string | number }

const DEFAULT_TIMEOUT = 5000

/**
 * Base primitive for browser-driven tests. Boots a real Bun server on an
 * ephemeral port, launches Playwright, and exposes navigation/interaction
 * helpers plus mail capture and direct session minting.
 *
 * This is the general-purpose surface. {@link DemoFlow} wraps it with
 * AGON-style fixture composition and magic-link sign-in.
 */
export class BrowserTestCase {
  config!: Configuration
  router!: Router
  db!: Database
  baseUrl!: string
  port!: number
  hostname!: string

  browser!: Browser
  context!: BrowserContext
  page!: Page

  private _serverHandle: ServerHandle | null = null
  private _memTransport: import('@strav/signal').MemoryMailTransport | null = null
  private _originalSql: SQL | null = null
  private _reserved: ReservedSQL | null = null
  private readonly options: BrowserTestCaseOptions

  constructor(options: BrowserTestCaseOptions = {}) {
    this.options = options
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /** Boot config + DB + (optional) auth/views, register routes, start a real Bun server, launch Playwright. Call in beforeAll. */
  async setup(): Promise<void> {
    if (this.options.fresh) await runFresh()

    if (!app.has(Configuration)) app.singleton(Configuration)
    if (!app.has(Router)) app.singleton(Router)

    this.config = app.resolve(Configuration)
    await this.config.load()

    const dbManager = TestDatabaseManager.getInstance()
    this.db = await dbManager.getDatabase()

    this.router = app.resolve(Router)
    this.router.setDomain(this.options.hostname ?? '127.0.0.1')

    if (this.options.auth !== false) {
      // Magic-link tokens, session csrf, and any encrypted payloads require
      // EncryptionManager to be keyed. Apps that already configure
      // `encryption.key` will overwrite this; tests without a configured key
      // get a deterministic fallback so the harness works out of the box.
      const { EncryptionManager } = await import('@strav/kernel')
      const configuredKey = (this.config.get('encryption.key', '') as string) || process.env.APP_KEY || ''
      EncryptionManager.useKey(configuredKey || 'browser-test-case-fixture-key-do-not-use-in-production')

      const { SessionManager, Auth } = await import('@strav/http')
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
      if (this.options.userResolver) Auth.useResolver(this.options.userResolver)
    }

    if (this.options.views) {
      const { ViewEngine } = await import('@strav/view')
      const { Context } = await import('@strav/http')
      if (!app.has(ViewEngine)) app.singleton(ViewEngine)
      const viewEngine = app.resolve(ViewEngine)
      Context.setViewEngine(viewEngine)
    }

    if (this.options.bootstrap) await this.options.bootstrap()
    if (this.options.routes) await this.options.routes()

    this.router.useExceptionHandler(new ExceptionHandler(true))

    if (this.options.mail !== 'real') {
      const { MailManager, MemoryMailTransport } = await import('@strav/signal')
      // MailManager needs a Configuration-backed instance for its static config.
      // If the app hasn't registered it, register + resolve to populate _config.
      if (!app.has(MailManager)) app.singleton(MailManager)
      app.resolve(MailManager)
      this._memTransport = new MemoryMailTransport()
      MailManager.useTransport(this._memTransport)
    }

    this._serverHandle = startListener(this.router, {
      port: this.options.port ?? 0,
      hostname: this.options.hostname ?? '127.0.0.1',
    })
    this.port = this._serverHandle.port
    this.hostname = this._serverHandle.hostname
    this.baseUrl = this._serverHandle.baseUrl

    const playwright = await loadPlaywright()
    const browserName = this.options.browser ?? 'chromium'
    const headless = this.options.headless ?? process.env.PLAYWRIGHT_HEADLESS !== '0'
    this.browser = await playwright[browserName].launch({
      headless,
      slowMo: this.options.slowMo ?? 0,
    })
  }

  /** Close browser, stop server, release DB. Call in afterAll. */
  async teardown(): Promise<void> {
    if (this.context) {
      try { await this.context.close() } catch { /* ignore */ }
    }
    if (this.browser) {
      try { await this.browser.close() } catch { /* ignore */ }
    }
    if (this._serverHandle) {
      stopListener(this._serverHandle)
      this._serverHandle = null
    }
    if (this._reserved) {
      try { await this._reserved`ROLLBACK` } catch { /* ignore */ }
      this._reserved.release()
      this._reserved = null
    }
    await TestDatabaseManager.getInstance().releaseDatabase()
  }

  /** Open a fresh incognito context + page; clear mail buffer; begin transaction (if opted-in). Call in beforeEach. */
  async beforeEach(): Promise<void> {
    if (this.options.transaction === true) {
      this._originalSql = this.db.sql
      this._reserved = await this._originalSql.reserve()
      await this._reserved`BEGIN`
      ;(this.db as any).appConnection = this._reserved
      ;(Database as any)._appConnection = this._reserved
    }
    if (this._memTransport) this._memTransport.clear()

    this.context = await this.browser.newContext()
    this.context.setDefaultTimeout(this.options.timeout ?? DEFAULT_TIMEOUT)
    this.page = await this.context.newPage()
  }

  /** Close the page/context and rollback the transaction. Call in afterEach. */
  async afterEach(): Promise<void> {
    if (this.context) {
      try { await this.context.close() } catch { /* ignore */ }
    }
    if (this._reserved) {
      try { await this._reserved`ROLLBACK` } catch { /* ignore */ }
      this._reserved.release()
      ;(this.db as any).appConnection = this._originalSql
      ;(Database as any)._appConnection = this._originalSql
      this._reserved = null
      this._originalSql = null
    }
  }

  /** Boot the test case and auto-register bun:test lifecycle hooks. */
  static async boot(options?: BrowserTestCaseOptions): Promise<BrowserTestCase> {
    const tc = new BrowserTestCase(options)
    await tc.setup()
    const { afterAll, beforeEach, afterEach } = await import('bun:test')
    afterAll(() => tc.teardown())
    beforeEach(() => tc.beforeEach())
    afterEach(() => tc.afterEach())
    return tc
  }

  // ---------------------------------------------------------------------------
  // Navigation
  // ---------------------------------------------------------------------------

  async goto(path: string): Promise<void> {
    const url = path.startsWith('http://') || path.startsWith('https://') ? path : `${this.baseUrl}${path}`
    await this.page.goto(url)
  }
  async reload(): Promise<void> { await this.page.reload() }
  async back(): Promise<void> { await this.page.goBack() }

  // ---------------------------------------------------------------------------
  // Interaction
  // ---------------------------------------------------------------------------

  async click(selector: string, opts?: { timeout?: number }): Promise<void> {
    await this.page.locator(selector).click({ timeout: opts?.timeout })
  }
  async fill(selector: string, value: string): Promise<void> {
    await this.page.locator(selector).fill(value)
  }
  async type(selector: string, value: string, opts?: { delay?: number }): Promise<void> {
    await this.page.locator(selector).pressSequentially(value, { delay: opts?.delay })
  }
  async press(selector: string, key: string): Promise<void> {
    await this.page.locator(selector).press(key)
  }
  async check(selector: string): Promise<void> {
    await this.page.locator(selector).check()
  }
  async selectOption(selector: string, value: string | string[]): Promise<void> {
    await this.page.locator(selector).selectOption(value)
  }
  async hover(selector: string): Promise<void> {
    await this.page.locator(selector).hover()
  }
  async uploadFile(selector: string, paths: string | string[]): Promise<void> {
    await this.page.locator(selector).setInputFiles(paths)
  }

  // ---------------------------------------------------------------------------
  // Wait
  // ---------------------------------------------------------------------------

  async waitFor(selector: string, opts?: { state?: 'attached' | 'visible' | 'hidden' | 'detached'; timeout?: number }): Promise<void> {
    await this.page.locator(selector).waitFor(opts)
  }
  async waitForUrl(url: string | RegExp, opts?: { timeout?: number }): Promise<void> {
    await this.page.waitForURL(url, opts)
  }
  async waitForRequest(urlOrPredicate: string | RegExp | ((req: PWRequest) => boolean)): Promise<void> {
    await this.page.waitForRequest(urlOrPredicate as any)
  }

  // ---------------------------------------------------------------------------
  // Assertions
  // ---------------------------------------------------------------------------

  async expectUrl(url: string | RegExp): Promise<void> {
    const current = this.page.url()
    if (typeof url === 'string') {
      // Allow callers to pass a path; resolve against baseUrl for comparison.
      const expected = url.startsWith('http://') || url.startsWith('https://') ? url : `${this.baseUrl}${url}`
      if (current !== expected) {
        throw new Error(`expectUrl failed: expected ${expected}, got ${current}`)
      }
    } else if (!url.test(current)) {
      throw new Error(`expectUrl failed: ${url} did not match ${current}`)
    }
  }

  async expectVisible(selector: string, text?: string | RegExp): Promise<void> {
    const locator = this.page.locator(selector).first()
    await locator.waitFor({ state: 'visible' })
    if (text !== undefined) {
      const actual = (await locator.textContent()) ?? ''
      if (typeof text === 'string') {
        if (!actual.includes(text)) {
          throw new Error(`expectVisible(${selector}) text mismatch: expected to include "${text}", got "${actual}"`)
        }
      } else if (!text.test(actual)) {
        throw new Error(`expectVisible(${selector}) text mismatch: ${text} did not match "${actual}"`)
      }
    }
  }

  async expectHidden(selector: string): Promise<void> {
    await this.page.locator(selector).first().waitFor({ state: 'hidden' })
  }

  async expectText(selector: string, text: string | RegExp): Promise<void> {
    const actual = (await this.page.locator(selector).first().textContent()) ?? ''
    if (typeof text === 'string') {
      if (actual !== text) throw new Error(`expectText(${selector}): expected "${text}", got "${actual}"`)
    } else if (!text.test(actual)) {
      throw new Error(`expectText(${selector}): ${text} did not match "${actual}"`)
    }
  }

  async expectAttribute(selector: string, name: string, value: string | RegExp): Promise<void> {
    const actual = (await this.page.locator(selector).first().getAttribute(name)) ?? ''
    if (typeof value === 'string') {
      if (actual !== value) throw new Error(`expectAttribute(${selector}, ${name}): expected "${value}", got "${actual}"`)
    } else if (!value.test(actual)) {
      throw new Error(`expectAttribute(${selector}, ${name}): ${value} did not match "${actual}"`)
    }
  }

  async expectCount(selector: string, count: number): Promise<void> {
    const actual = await this.page.locator(selector).count()
    if (actual !== count) throw new Error(`expectCount(${selector}): expected ${count}, got ${actual}`)
  }

  async expectComputedStyle(selector: string, property: string, matcher: Matcher): Promise<void> {
    // Split off a ::pseudo-element segment so it's passed to getComputedStyle's second arg.
    const { base, pseudo } = splitPseudo(selector)
    const actual = await this.page.evaluate<string | null, { base: string; pseudo: string | null; property: string }>(
      // The body runs in the browser context — `document` and `window` are
      // ambient there. We don't enable the DOM lib at the package level
      // because it conflicts with kernel's buffer types, so this callback
      // is typed via the explicit generic above.
      ((args: { base: string; pseudo: string | null; property: string }) => {
        const el = (globalThis as any).document.querySelector(args.base)
        if (!el) return null
        const style = args.pseudo
          ? (globalThis as any).window.getComputedStyle(el, args.pseudo)
          : (globalThis as any).window.getComputedStyle(el)
        return style.getPropertyValue(args.property) as string
      }) as any,
      { base, pseudo, property }
    )
    if (actual === null) {
      throw new Error(`expectComputedStyle(${selector}, ${property}): element not found`)
    }

    if (typeof matcher === 'string') {
      if (!actual.includes(matcher)) {
        throw new Error(`expectComputedStyle(${selector}, ${property}): expected to include "${matcher}", got "${actual}"`)
      }
      return
    }
    if (matcher instanceof RegExp) {
      if (!matcher.test(actual)) {
        throw new Error(`expectComputedStyle(${selector}, ${property}): ${matcher} did not match "${actual}"`)
      }
      return
    }

    const actualNum = parsePxNumber(actual)
    const expect = (cmp: 'gt' | 'lt' | 'eq', threshold: string | number): boolean => {
      const t = typeof threshold === 'string' ? parsePxNumber(threshold) : threshold
      if (actualNum === null || t === null) return false
      switch (cmp) {
        case 'gt': return actualNum > t
        case 'lt': return actualNum < t
        case 'eq': return actualNum === t
      }
    }
    if (matcher.gt !== undefined && !expect('gt', matcher.gt)) {
      throw new Error(`expectComputedStyle(${selector}, ${property}): expected > ${matcher.gt}, got "${actual}"`)
    }
    if (matcher.lt !== undefined && !expect('lt', matcher.lt)) {
      throw new Error(`expectComputedStyle(${selector}, ${property}): expected < ${matcher.lt}, got "${actual}"`)
    }
    if (matcher.eq !== undefined && !expect('eq', matcher.eq)) {
      throw new Error(`expectComputedStyle(${selector}, ${property}): expected == ${matcher.eq}, got "${actual}"`)
    }
  }

  // ---------------------------------------------------------------------------
  // Escape hatches
  // ---------------------------------------------------------------------------

  async evaluate<T>(fn: (...args: any[]) => T, ...args: any[]): Promise<T> {
    return this.page.evaluate(fn as any, ...args) as Promise<T>
  }
  async screenshot(_name?: string): Promise<Buffer> {
    return await this.page.screenshot()
  }
  async cookies(): Promise<Cookie[]> {
    return await this.context.cookies()
  }
  async setCookie(cookie: Cookie): Promise<void> {
    await this.context.addCookies([cookie])
  }

  // ---------------------------------------------------------------------------
  // Auth helpers
  // ---------------------------------------------------------------------------

  /**
   * Mint a session for the user via {@link Session.createForUser} and set the
   * session cookie on the Playwright browser context. Default for tests that
   * are not exercising the auth flow itself.
   */
  async signInAs(user: unknown): Promise<void> {
    const { Session, SessionManager } = await import('@strav/http')
    const session = await Session.createForUser(user, {
      ipAddress: '127.0.0.1',
      userAgent: 'BrowserTestCase',
    })
    const cfg = SessionManager.config
    await this.context.addCookies([{
      name: cfg.cookie,
      value: session.id,
      domain: this.hostname,
      path: '/',
      httpOnly: cfg.httpOnly ?? true,
      secure: false,
      sameSite: normalizeSameSite(cfg.sameSite),
    }])
  }

  /**
   * Full-flow magic-link sign-in: POST to the magic-link endpoint, wait for
   * the captured mail to arrive, follow the link in the page. Use this when
   * the test is verifying the auth flow itself.
   */
  async signInWithMagicLink(opts: {
    email: string
    endpoint?: string
    tokenParam?: string
    subject?: string | RegExp
  }): Promise<void> {
    if (!this._memTransport) {
      throw new Error('signInWithMagicLink requires mail capture; construct BrowserTestCase with mail: "capture" (the default).')
    }
    const endpoint = opts.endpoint ?? '/auth/magic'
    // Use native fetch (not page.request) — Playwright's request module
    // routes through the chromium subprocess pipe, which has surfaced
    // flaky "context closed" errors when the server is in-process.
    const issueRes = await fetch(`${this.baseUrl}${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: opts.email }),
    })
    if (!issueRes.ok) {
      throw new Error(`signInWithMagicLink: ${endpoint} returned ${issueRes.status}: ${await issueRes.text()}`)
    }
    const mail = await this._memTransport.waitFor({ to: opts.email, subject: opts.subject })
    const param = opts.tokenParam ?? 'token'
    const escaped = param.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const link = this._memTransport.extractLink(mail, new RegExp(`https?:\\/\\/[^\\s"'<>]+[?&]${escaped}=[^\\s"'<>&]+`))
    if (!link) throw new Error(`signInWithMagicLink: no magic link with ?${param}=… found in mail to ${opts.email}`)

    // Follow the verify link via fetch (manual redirect handling) so we can
    // pluck the Set-Cookie header without a real browser navigation. Then
    // inject the cookie into Playwright's context.
    const verifyRes = await fetch(link, { redirect: 'manual' })
    const setCookieRaw = (verifyRes.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.()
      ?? splitSetCookie(verifyRes.headers.get('set-cookie'))
    const sessionCookie = pickSessionCookie(setCookieRaw)
    if (!sessionCookie) {
      throw new Error(`signInWithMagicLink: ${link} did not return a Set-Cookie header (status ${verifyRes.status}).`)
    }
    const { SessionManager } = await import('@strav/http')
    await this.context.addCookies([{
      name: SessionManager.config.cookie,
      value: sessionCookie,
      domain: this.hostname,
      path: '/',
      httpOnly: true,
      secure: false,
      sameSite: normalizeSameSite(SessionManager.config.sameSite),
    }])
  }

  /** Returns the in-memory mail transport. Throws if mail !== 'capture'. */
  capturedMail(): import('@strav/signal').MemoryMailTransport {
    if (!this._memTransport) {
      throw new Error('capturedMail() requires mail: "capture" (the default for BrowserTestCase).')
    }
    return this._memTransport
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function loadPlaywright(): Promise<typeof import('playwright-core')> {
  try {
    return await import('playwright-core')
  } catch (err) {
    throw new Error(
      `BrowserTestCase requires 'playwright-core' to be installed. Run: bun add -D playwright-core && bun x playwright install chromium. (${(err as Error).message})`
    )
  }
}

function splitPseudo(selector: string): { base: string; pseudo: string | null } {
  const match = selector.match(/^(.*?)(::[a-z-]+(?:\([^)]*\))?)\s*$/i)
  if (match) return { base: match[1]!.trim(), pseudo: match[2]! }
  return { base: selector, pseudo: null }
}

function parsePxNumber(value: string): number | null {
  const m = value.match(/-?\d+(?:\.\d+)?/)
  return m ? parseFloat(m[0]) : null
}

function splitSetCookie(raw: string | null): string[] {
  if (!raw) return []
  // Naive split: assumes no commas inside attribute values, which holds for
  // session cookies (UUID id + standard attrs). For multiple cookies in one
  // header, browsers traditionally use comma + space — but inside attrs
  // like Expires, comma can appear too. We rely on the modern getSetCookie
  // API when available; this is a best-effort fallback.
  return [raw]
}

function pickSessionCookie(setCookies: string[]): string | null {
  for (const raw of setCookies) {
    const match = raw.match(/^(?:strav_session)=([^;]+)/)
    if (match) return decodeURIComponent(match[1]!)
  }
  return null
}

function normalizeSameSite(value: unknown): 'Strict' | 'Lax' | 'None' {
  if (typeof value !== 'string') return 'Lax'
  const lower = value.toLowerCase()
  if (lower === 'strict') return 'Strict'
  if (lower === 'none') return 'None'
  return 'Lax'
}

// Keep BaseModel as a type-side reference so tree-shakers don't drop the
// Database peer dep; some test apps rely on extractUserId via @strav/database.
void BaseModel
