import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { BrowserTestCase } from '../../src/browser/test_case.ts'
import { registerFixtureRoutes } from './fixtures/app.ts'

// These tests need a Postgres test DB AND a Playwright Chromium binary.
// Skip the suite cleanly if Chromium isn't available so the package's
// non-browser tests can still run.
const chromiumAvailable = await checkChromium()
const describeIfBrowser = chromiumAvailable ? describe : describe.skip

describeIfBrowser('BrowserTestCase', () => {
  let t: BrowserTestCase

  beforeAll(async () => {
    t = new BrowserTestCase({
      bootstrap: () => registerFixtureRoutes(),
      auth: true,
      mail: 'capture',
    })
    await t.setup()
  })

  afterAll(async () => {
    await t.teardown()
  })

  beforeEach(async () => {
    await t.beforeEach()
  })

  afterEach(async () => {
    await t.afterEach()
  })

  test('boots an in-process server on an ephemeral port and serves /ping', async () => {
    expect(t.port).toBeGreaterThan(0)
    expect(t.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)

    const res = await fetch(`${t.baseUrl}/ping`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  test('signInAs mints a session and the cookie unlocks /dashboard without going through the email loop', async () => {
    await t.signInAs('u-direct')
    await t.goto('/dashboard')
    await t.expectVisible('h1.welcome', 'Dashboard')
    expect(t.capturedMail().all()).toHaveLength(0)
  })

  test('expectComputedStyle accepts string, RegExp, and { gt } matchers', async () => {
    await t.signInAs('u-styles')
    await t.goto('/dashboard')

    await t.expectComputedStyle('h1.welcome', 'font-family', /Newsreader/)
    await t.expectComputedStyle('h1.welcome', 'color', 'rgb(184, 68, 44)')
    await t.expectComputedStyle('h1.welcome', 'font-size', { gt: 20 })
    await t.expectComputedStyle('p.lede::first-letter', 'font-size', { gt: 40 })
  })

  test('expectComputedStyle throws with selector + property + actual on mismatch', async () => {
    await t.signInAs('u-styles-fail')
    await t.goto('/dashboard')
    await expect(
      t.expectComputedStyle('h1.welcome', 'font-family', /DefinitelyNotThisFont/),
    ).rejects.toThrow(/font-family.*Newsreader/s)
  })

  test('screenshot returns a Buffer', async () => {
    await t.goto('/ping')
    const buf = await t.screenshot()
    expect(buf).toBeInstanceOf(Buffer)
    expect(buf.length).toBeGreaterThan(0)
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
