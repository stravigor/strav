import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { DemoFlow } from '../../src/browser/demo_flow.ts'
import { BrowserTestCase } from '../../src/browser/test_case.ts'
import { registerFixtureRoutes } from './fixtures/app.ts'

const chromiumAvailable = await checkChromium()
const describeIfBrowser = chromiumAvailable ? describe : describe.skip

describeIfBrowser('DemoFlow', () => {
  let tc: BrowserTestCase
  let flow: DemoFlow

  beforeAll(async () => {
    tc = new BrowserTestCase({
      bootstrap: () => registerFixtureRoutes(),
      auth: true,
      mail: 'capture',
      fresh: false,
    })
    await tc.setup()
    flow = new DemoFlow(tc)
  })

  afterAll(async () => {
    await tc.teardown()
  })

  beforeEach(async () => {
    await tc.beforeEach()
  })

  afterEach(async () => {
    await tc.afterEach()
  })

  test('signIn posts to the magic-link endpoint, follows the captured link, and lands signed in', async () => {
    await flow.signIn({ email: 'demo@example.com' })
    await flow.goto('/dashboard')
    await flow.expectVisible('h1.welcome', 'Dashboard')

    const captured = tc.capturedMail().all()
    expect(captured.length).toBeGreaterThanOrEqual(1)
    expect(captured[0]!.to).toBe('demo@example.com')
    expect(captured[0]!.subject).toBe('Sign in to the demo')
  })

  test('signInAs skips the email loop entirely', async () => {
    await flow.signInAs('u-skip')
    await flow.goto('/dashboard')
    await flow.expectVisible('h1.welcome', 'Dashboard')
    expect(tc.capturedMail().all()).toHaveLength(0)
  })

  test('expectComputedStyle delegates correctly', async () => {
    await flow.signInAs('u-style')
    await flow.goto('/dashboard')
    await flow.expectComputedStyle('h1.welcome', 'font-family', /Newsreader/)
  })
})

async function checkChromium(): Promise<boolean> {
  try {
    const playwright = await import('playwright-core')
    const browser = await playwright.chromium.launch({ headless: true })
    await browser.close()
    return true
  } catch {
    return false
  }
}
