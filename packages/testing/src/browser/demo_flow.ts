import type { Page } from 'playwright-core'
import { BrowserTestCase } from './test_case.ts'
import type { BrowserTestCaseOptions } from './test_case.ts'

export interface DemoFlowOptions extends BrowserTestCaseOptions {
  /** Default: '/auth/magic' — the conventional magic-link endpoint. */
  signInEndpoint?: string
}

/**
 * Opinionated wrapper around {@link BrowserTestCase} that ships the AGON
 * "demo flow" surface: magic-link sign-in via captured mail, fixture
 * composition for slice-by-slice extension, and stricter defaults
 * (`fresh: true`, `mail: 'capture'`).
 *
 * Apps doing general browser testing should reach for `BrowserTestCase`
 * directly; `DemoFlow` exists for the AGON slice-DoD use case.
 */
export class DemoFlow {
  readonly tc: BrowserTestCase
  private readonly signInEndpoint: string

  constructor(tc: BrowserTestCase, options: DemoFlowOptions = {}) {
    this.tc = tc
    this.signInEndpoint = options.signInEndpoint ?? '/auth/magic'
  }

  /** Boot a DemoFlow — defaults `fresh: true`, `mail: 'capture'`. */
  static async boot(options: DemoFlowOptions = {}): Promise<DemoFlow> {
    const tc = await BrowserTestCase.boot({
      fresh: options.fresh ?? true,
      mail: options.mail ?? 'capture',
      ...options,
    })
    return new DemoFlow(tc, options)
  }

  /**
   * Build a fixture function that returns a fresh DemoFlow with `setup`
   * applied. Fixture flows compose: `withWorkspace` can call
   * `signedInUser()` and extend it.
   */
  static fixture<T extends DemoFlow>(setup: (flow: DemoFlow) => Promise<T>): () => Promise<T> {
    return async () => {
      const flow = await DemoFlow.boot()
      return await setup(flow)
    }
  }

  // Direct passthrough to the Playwright page for escape hatches.
  get page(): Page { return this.tc.page }

  // ---------------------------------------------------------------------------
  // Delegated DSL
  // ---------------------------------------------------------------------------

  goto(path: string): Promise<void> { return this.tc.goto(path) }
  click(selector: string): Promise<void> { return this.tc.click(selector) }
  fill(selector: string, value: string): Promise<void> { return this.tc.fill(selector, value) }
  expectUrl(url: string | RegExp): Promise<void> { return this.tc.expectUrl(url) }
  expectVisible(selector: string, text?: string | RegExp): Promise<void> { return this.tc.expectVisible(selector, text) }
  expectComputedStyle(
    selector: string,
    property: string,
    matcher: Parameters<BrowserTestCase['expectComputedStyle']>[2],
  ): Promise<void> {
    return this.tc.expectComputedStyle(selector, property, matcher)
  }

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------

  /**
   * Sign in via the captured magic-link flow. Posts to the configured
   * endpoint, waits for the captured email, follows the link.
   */
  signIn(opts: { email: string; endpoint?: string; subject?: string | RegExp; tokenParam?: string }): Promise<void> {
    return this.tc.signInWithMagicLink({
      email: opts.email,
      endpoint: opts.endpoint ?? this.signInEndpoint,
      subject: opts.subject,
      tokenParam: opts.tokenParam,
    })
  }

  /** Skip the email loop — mint a session directly for `user`. */
  signInAs(user: unknown): Promise<void> { return this.tc.signInAs(user) }
}
