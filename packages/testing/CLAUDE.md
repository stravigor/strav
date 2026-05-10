# @strav/testing

Testing utilities for the Strav framework. TestCase boots your app, provides HTTP helpers, and wraps each test in a rolled-back database transaction for full isolation.

## Dependencies
- @strav/kernel (peer)
- @strav/http (peer)
- @strav/database (peer)

## Commands
- bun test
- bun run build

## Architecture
- src/test_case.ts — base test case class with app boot and transaction wrapping
- src/factory.ts — model factories for test data generation
- src/browser/ — browser-driven testing (Playwright)
  - test_case.ts — `BrowserTestCase`: boots a real Bun server on an
    ephemeral port, launches Playwright, exposes navigation/interaction/
    assertion helpers + mail capture + direct session minting.
  - demo_flow.ts — `DemoFlow`: opinionated wrapper for AGON slice DoD —
    magic-link sign-in via captured mail, fixture composition.
  - server_lifecycle.ts — port=0 listener helpers reading `Server.port`.
  - db_fresh.ts — `runFresh()` (lazy `@strav/cli` import, APP_ENV guard).
- src/index.ts — public API (re-exports browser surface)

## Conventions
- Tests extend TestCase for automatic app lifecycle and DB isolation
- Use factories for creating test data — don't insert records manually
- Each test runs in a transaction that is rolled back after completion
  (TestCase only — `BrowserTestCase` defaults `transaction: false` because
  the in-process real-HTTP server contends for the reserved connection)

## Browser testing setup
- `bun add -D playwright-core` (already a devDep on `@strav/testing`)
- `bun x playwright install chromium` — fetches the matching Chromium
  binary (~150 MB). Re-run after upgrading playwright-core.
- Set `PLAYWRIGHT_CHROMIUM_USE_HEADLESS_SHELL=0` if `chrome-headless-shell`
  surfaces flakiness — it forces the full Chromium binary.
- Browser tests need APP_ENV=test (or local) and a reachable Postgres.
- For per-test DB isolation in browser tests, use `fresh: true` (slower
  but bulletproof) rather than transactions.
