# Testing

`@strav/testing` ships two primitives:

- **`TestCase`** — boots your app, dispatches requests through the router in-memory, wraps each test in a rolled-back transaction. The default for backend tests.
- **`BrowserTestCase`** — boots a real Bun HTTP server on an ephemeral port, drives a Playwright browser against it, captures outbound mail, mints sessions directly. For end-to-end tests that exercise rendered HTML, navigation, computed styles, or the full magic-link auth flow.

`Factory` and `MemoryMailTransport` are shared across both.

## Quick Start

```typescript
import { describe, test, expect } from 'bun:test'
import { TestCase, Factory } from '@strav/testing'
import User from '../app/models/user'

const UserFactory = Factory.define(User, (seq) => ({
  pid: crypto.randomUUID(),
  name: `User ${seq}`,
  email: `user-${seq}@test.com`,
  passwordHash: 'hashed',
}))

const t = await TestCase.boot({
  auth: true,
  domain: 'example.com',
  routes: () => import('../start/api_routes'),
})

describe('Users API', () => {
  test('list users', async () => {
    const user = await UserFactory.create()
    await t.actingAs(user)

    const res = await t.get('/api/users')
    expect(res.status).toBe(200)
  })

  // No cleanup needed — transaction auto-rollbacks after each test
})
```

## TestCase

### Boot

`TestCase.boot()` registers `beforeEach`, `afterEach`, and `afterAll` hooks automatically:

```typescript
const t = await TestCase.boot({
  routes: () => import('../start/api_routes'),
})
```

For manual control, use the instance methods directly:

```typescript
const t = new TestCase()
beforeAll(() => t.setup())
afterAll(() => t.teardown())
beforeEach(() => t.beforeEach())
afterEach(() => t.afterEach())
```

### Options

```typescript
const t = await TestCase.boot({
  // Load route files (called once during setup)
  routes: () => import('../start/api_routes'),

  // Boot Auth + SessionManager, create their tables (default: false)
  auth: true,

  // Set Auth.useResolver() for loading users by ID
  userResolver: async (id) => User.find(id as string),

  // Boot ViewEngine (default: false)
  views: true,

  // Wrap each test in a transaction (default: true)
  transaction: true,

  // Base domain for subdomain extraction (default: 'localhost')
  domain: 'example.com',
})
```

### HTTP Helpers

All helpers call `router.handle()` directly — no HTTP server needed, no port conflicts:

```typescript
const res = await t.get('/api/users')
const res = await t.post('/api/users', { name: 'Alice' })
const res = await t.put('/api/users/1', { name: 'Bob' })
const res = await t.patch('/api/users/1', { name: 'Charlie' })
const res = await t.delete('/api/users/1')
```

Bodies are automatically serialized as JSON. Custom headers can be passed as the last argument:

```typescript
const res = await t.get('/api/users', { 'X-Custom': 'value' })
const res = await t.post('/api/users', body, { 'X-Custom': 'value' })
```

### Authentication

```typescript
// Authenticate as a user (creates a real AccessToken)
const user = await UserFactory.create()
await t.actingAs(user)

// All subsequent requests include the Bearer token
const res = await t.get('/api/profile')  // Authenticated

// Clear authentication
t.withoutAuth()
const res = await t.get('/api/profile')  // Unauthenticated
```

Auth state resets automatically after each test (via `afterEach`).

### Custom Headers

```typescript
t.withHeaders({ 'Accept-Language': 'fr' })
const res = await t.get('/api/content')
```

Headers reset after each test.

### Subdomain Testing

Test subdomain-based APIs (e.g., `api.example.com`) using the subdomain helpers:

```typescript
// Test routes on api.example.com
await t.onSubdomain('api').get('/users')
await t.onSubdomain('api').post('/posts', { title: 'Hello' })

// Test tenant-specific routes (tenant.example.com)
await t.onSubdomain('acme').get('/dashboard')
// ctx.params.tenant === 'acme' in subdomain routes

// Clear subdomain for main domain requests
t.withoutSubdomain()
await t.get('/health')  // example.com/health
```

Subdomain state resets automatically after each test.

**Note:** You must set `domain: 'example.com'` in `TestCase.boot()` for subdomain routing to work properly.

### Exposed Properties

```typescript
t.db       // Database instance — for direct SQL queries
t.router   // Router instance — for custom assertions
t.config   // Configuration instance — for reading config values
```

## Transaction Isolation

By default, every test runs inside a database transaction that rolls back when the test completes. This means:

- Tests are fully isolated — data created in one test is invisible to the next
- No `DELETE FROM` cleanup needed
- Tests can run in any order
- Fast — rollback is cheaper than delete + re-insert

To disable transaction wrapping (e.g., for tests that don't touch the database):

```typescript
const t = await TestCase.boot({ transaction: false })
```

## Factory

### Shared factory definitions

Define factories in `database/factories/` so both tests and [seeders](./database.md#seeding) can import them:

```
database/
  factories/
    user_factory.ts
    post_factory.ts
    index.ts          # re-exports all factories
```

```typescript
// database/factories/user_factory.ts
import { Factory } from '@strav/testing'
import User from '../../app/models/user'

export const UserFactory = Factory.define(User, (seq) => ({
  pid: crypto.randomUUID(),
  name: `User ${seq}`,
  email: `user-${seq}@test.com`,
  passwordHash: 'hashed',
}))
```

Then import in tests:

```typescript
import { UserFactory, PostFactory } from '../database/factories'
```

### Define

```typescript
import { Factory } from '@strav/testing'
import User from '../app/models/user'
import Post from '../app/models/post'

const UserFactory = Factory.define(User, (seq) => ({
  pid: crypto.randomUUID(),
  name: `User ${seq}`,
  email: `user-${seq}@test.com`,
  passwordHash: 'hashed',
}))

const PostFactory = Factory.define(Post, (seq) => ({
  title: `Post ${seq}`,
  body: 'Lorem ipsum',
  status: 'draft',
}))
```

The `seq` argument is an auto-incrementing number (1, 2, 3...) unique to each factory, useful for generating unique values.

### Create

```typescript
// Create and persist a single record
const user = await UserFactory.create()

// With overrides
const admin = await UserFactory.create({ name: 'Admin', role: 'admin' })

// Create multiple
const users = await UserFactory.createMany(5)
const editors = await UserFactory.createMany(3, { role: 'editor' })
```

### Make (No Database)

Build an in-memory instance without persisting:

```typescript
const user = UserFactory.make()
user._exists  // false — not in the database
user.name     // 'User 1'

const custom = UserFactory.make({ name: 'Override' })
```

### Reset Sequences

```typescript
Factory.resetSequences()  // Resets all factory counters to 0
```

## API Testing Patterns

### Prefix vs Subdomain Routing

Strav supports two approaches for API organization:

#### 1. Path Prefix (Traditional)
```typescript
// Route registration
router.group({ prefix: '/api' }, (r) => {
  r.get('/users', listUsers)       // example.com/api/users
  r.post('/posts', createPost)     // example.com/api/posts
})

// Testing
const res = await t.get('/api/users')
```

#### 2. Subdomain-based
```typescript
// Route registration
router.setDomain('example.com')
router.subdomain('api', (r) => {
  r.get('/users', listUsers)       // api.example.com/users
  r.post('/posts', createPost)     // api.example.com/posts
})

// Testing
const t = await TestCase.boot({ domain: 'example.com' })
const res = await t.onSubdomain('api').get('/users')
```

#### Multi-tenant with Dynamic Subdomains
```typescript
// Route registration
router.subdomain(':tenant', (r) => {
  r.get('/dashboard', (ctx) => {
    const tenant = ctx.params.tenant  // 'acme', 'corp', etc.
    return ctx.json({ tenant })
  })
})

// Testing
await t.onSubdomain('acme').get('/dashboard')    // acme.example.com/dashboard
await t.onSubdomain('corp').get('/dashboard')    // corp.example.com/dashboard
```

## Full Example

```typescript
import { describe, test, expect } from 'bun:test'
import { TestCase, Factory } from '@strav/testing'
import User from '../app/models/user'
import Post from '../app/models/post'

const UserFactory = Factory.define(User, (seq) => ({
  pid: crypto.randomUUID(),
  name: `User ${seq}`,
  email: `user-${seq}@test.com`,
  passwordHash: 'hashed',
}))

const PostFactory = Factory.define(Post, (seq) => ({
  title: `Post ${seq}`,
  body: `Content for post ${seq}`,
}))

const t = await TestCase.boot({
  auth: true,
  domain: 'example.com',
  userResolver: async (id) => User.find(id as string),
  routes: () => import('../start/api_routes'),
})

describe('Posts API', () => {
  test('create a post', async () => {
    const user = await UserFactory.create()
    await t.actingAs(user)

    const res = await t.post(`/api/users/${user.pid}/posts`, {
      title: 'My Post',
      body: 'Hello world',
    })

    expect(res.status).toBe(201)
    const data = await res.json() as any
    expect(data.title).toBe('My Post')
  })

  test('list posts for a user', async () => {
    const user = await UserFactory.create()
    await t.actingAs(user)

    // Create posts with the factory
    await PostFactory.create({ userPid: user.pid })
    await PostFactory.create({ userPid: user.pid })

    const res = await t.get(`/api/users/${user.pid}/posts`)
    expect(res.status).toBe(200)
    const data = await res.json() as any[]
    expect(data).toHaveLength(2)
  })

  test('unauthenticated request returns 401', async () => {
    const res = await t.get('/api/profile')
    expect(res.status).toBe(401)
  })

  test('API on subdomain', async () => {
    const user = await UserFactory.create()
    await t.actingAs(user)

    // Test API routes on api.example.com subdomain
    await t.onSubdomain('api')
    const res = await t.get('/users')  // api.example.com/users
    expect(res.status).toBe(200)
  })

  test('tenant subdomain with parameter', async () => {
    const user = await UserFactory.create()
    await t.actingAs(user)

    // Test tenant routes: acme.example.com/dashboard
    // Router should be configured with router.subdomain(':tenant', ...)
    const res = await t.onSubdomain('acme').get('/dashboard')
    expect(res.status).toBe(200)

    // Route handler can access ctx.params.tenant === 'acme'
  })
})
```

## BrowserTestCase

`BrowserTestCase` boots a real Bun HTTP server on an ephemeral port, launches Playwright, and gives you a typed DSL for navigation, interaction, computed-style assertions, mail capture, and direct session minting. Use it for the parts of your app `TestCase` can't reach: server-rendered HTML, Vue islands, redirect chains, the magic-link auth flow, typography fidelity.

### Setup

```bash
# devDep — already declared on @strav/testing as an optional peer
bun add -D playwright-core

# install the matching Chromium binary (~150 MB; one-time)
bun x playwright install chromium

# in CI, also cache ~/.cache/ms-playwright (Linux) or ~/Library/Caches/ms-playwright (macOS)
```

If `chrome-headless-shell` surfaces flakiness on your platform, set `PLAYWRIGHT_CHROMIUM_USE_HEADLESS_SHELL=0` to use the full Chromium binary.

### Quick start

```typescript
import { describe, test } from 'bun:test'
import { BrowserTestCase } from '@strav/testing'

const t = await BrowserTestCase.boot({
  bootstrap: () => import('../start/routes'),
  auth: true,
})

describe('Dashboard', () => {
  test('renders the editorial header for a signed-in user', async () => {
    await t.signInAs('user-1')
    await t.goto('/dashboard')
    await t.expectVisible('h1.welcome', 'Dashboard')
    await t.expectComputedStyle('h1.welcome', 'font-family', /Newsreader/)
  })
})
```

### Boot options

```typescript
const t = await BrowserTestCase.boot({
  bootstrap:    () => import('../start/routes'),  // run once during setup
  routes:       () => import('../start/routes'),  // alias when you only register routes
  auth:         true,                             // boot Auth + SessionManager (default: true)
  views:        false,                            // boot ViewEngine
  fresh:        false,                            // run `bun strav fresh` once before setup (APP_ENV=test|local)
  mail:         'capture',                        // 'capture' (default) swaps in MemoryMailTransport; 'real' leaves the configured driver
  browser:      'chromium',                       // 'chromium' | 'firefox' | 'webkit'
  headless:     true,                             // PLAYWRIGHT_HEADLESS=0 forces visible
  slowMo:       0,                                // ms between actions when debugging
  timeout:      5000,                             // default action timeout
  port:         0,                                // 0 = ephemeral
  hostname:     '127.0.0.1',
  transaction:  false,                            // see "Test isolation" below
})
```

### Lifecycle

`BrowserTestCase.boot()` registers `beforeAll`, `afterAll`, `beforeEach`, and `afterEach` hooks automatically. For manual control, instantiate and wire each hook yourself (`new BrowserTestCase(opts)` then `t.setup()`/`t.teardown()`/`t.beforeEach()`/`t.afterEach()`).

### Navigation and interaction

```typescript
await t.goto('/dashboard')          // resolves against baseUrl
await t.click('a:has-text("Posts")')
await t.fill('input[name="title"]', 'My post')
await t.press('input[name="title"]', 'Enter')
await t.check('input[type="checkbox"]')
await t.selectOption('select[name="role"]', 'editor')
await t.uploadFile('input[type="file"]', './fixtures/avatar.png')
await t.hover('.menu-trigger')
await t.reload()
```

### Waits

```typescript
await t.waitFor('.toast-success')
await t.waitForUrl(/\/checkout\/success$/, { timeout: 10_000 })
await t.waitForRequest(/\/api\/orders/)
```

### Assertions

```typescript
await t.expectUrl(/\/dashboard$/)
await t.expectVisible('h1', 'Welcome')
await t.expectHidden('.spinner')
await t.expectText('h1', 'Welcome')
await t.expectAttribute('img.avatar', 'alt', /avatar/i)
await t.expectCount('li.post', 5)
```

### Computed styles

`expectComputedStyle(selector, property, matcher)` reads `getComputedStyle()` in the page. The matcher accepts a string (substring match), a RegExp, or a numeric comparator object — handy for asserting font fidelity, drop-cap sizes, and accent colours without snapshotting.

```typescript
await t.expectComputedStyle('h1', 'font-family', /Newsreader/)
await t.expectComputedStyle('h1', 'color', 'rgb(184, 68, 44)')
await t.expectComputedStyle('h1', 'font-size', { gt: 20 })
await t.expectComputedStyle('p.lede::first-letter', 'font-size', { gt: 40 })
```

### Sign-in

Two helpers — pick by intent.

```typescript
// Default — mints a session row directly via Session.createForUser and
// injects the cookie into Playwright's context. No email loop.
await t.signInAs('user-1')

// Use this when the test is verifying the magic-link flow itself: posts
// to the magic-link endpoint, waits for the captured mail, follows the
// link, and injects the resulting session cookie. Requires mail: 'capture'.
await t.signInWithMagicLink({
  email:      'demo@example.com',
  endpoint:   '/auth/magic',         // default
  tokenParam: 'token',                // default
  subject:    /Sign in/,              // optional — narrows the mail match
})
```

### Mail capture

When `mail: 'capture'` (the default), an in-memory `MemoryMailTransport` replaces the configured driver. Query it directly:

```typescript
const captured = t.capturedMail().all()
const mail     = await t.capturedMail().waitFor({ to: 'demo@example.com' })
const link     = t.capturedMail().lastMagicLinkFor('demo@example.com')
t.capturedMail().clear()
```

### Escape hatches

```typescript
const buf = await t.screenshot()                   // Buffer
const out = await t.evaluate(() => document.title)
const cookies = await t.cookies()
await t.setCookie({ name: 'flag', value: 'on', domain: t.hostname, path: '/' })

// Direct Playwright access for anything not covered by the DSL
const locator = t.page.locator('[data-test=submit]')
```

### Test isolation

Unlike `TestCase`, `BrowserTestCase` defaults `transaction: false`. The real-HTTP server runs in-process and a single navigation triggers multiple in-flight requests (page + favicon + static + session writes) that contend for one reserved connection — pool starvation results.

For per-test DB isolation, prefer one of:

- `fresh: true` — run `bun strav fresh` once before the file's tests (slower but bulletproof).
- Hand-rolled cleanup in `afterEach` — `await t.db.sql\`TRUNCATE … CASCADE\``.
- File-level scoping: keep mutating tests in their own file with a fresh DB.

### Composing slice flows with DemoFlow

`DemoFlow` is an opinionated wrapper for AGON-style slice/demo tests. It boots a `BrowserTestCase` with `fresh: true` and `mail: 'capture'`, exposes a tighter DSL, and composes via fixture flows:

```typescript
import { describe, test } from 'bun:test'
import { DemoFlow } from '@strav/testing'

const flow = await DemoFlow.boot({
  bootstrap: () => import('../start/routes'),
  auth:      true,
})

describe('Slice 003 — reader demo flow', () => {
  test('user signs in and sees editorial typography', async () => {
    await flow.signIn({ email: 'demo@example.com' })

    await flow.goto('/workspaces/new')
    await flow.fill('input[name="name"]', 'Demo Cloud')
    await flow.click('button[type="submit"]')

    await flow.expectUrl(/\/workspaces\/demo-cloud$/)
    await flow.click('a:has-text("Welcome to Runbooks")')
    await flow.expectComputedStyle('.read h1', 'font-family', /Newsreader/)
    await flow.expectComputedStyle('.read .lede::first-letter', 'font-size', { gt: 40 })
  })
})
```

#### Fixture composition

```typescript
// tests/utils/flows.ts
import { DemoFlow } from '@strav/testing'

export const signedInUser = DemoFlow.fixture(async (flow) => {
  await flow.signIn({ email: 'demo@example.com' })
  return flow
})

export const withWorkspace = DemoFlow.fixture(async (flow) => {
  await flow.signIn({ email: 'demo@example.com' })
  await flow.goto('/workspaces/new')
  await flow.fill('input[name="name"]', 'Demo Cloud')
  await flow.click('button[type="submit"]')
  return flow
})
```

```typescript
// tests/spaces/slice-003.flow.test.ts
import { withWorkspace } from '../utils/flows'

test('reader renders inside a workspace', async () => {
  const flow = await withWorkspace()
  await flow.click('a:has-text("Welcome to Runbooks")')
  await flow.expectComputedStyle('.read h1', 'font-family', /Newsreader/)
})
```

Each slice's flow file imports a fixture and only writes the steps for its own surface — the auth + workspace preamble is one import, not 12 lines repeated per slice.

## MemoryMailTransport

`MemoryMailTransport` (in `@strav/signal`) is the capture driver `BrowserTestCase` installs by default, but you can use it standalone in any test that asserts on outgoing mail:

```typescript
import { MailManager, MemoryMailTransport } from '@strav/signal'

const mail = new MemoryMailTransport({ maxSize: 100 })
MailManager.useTransport(mail)

// … exercise code that sends mail …

const m = await mail.waitFor({ to: 'user@example.com', subject: /Welcome/ })
const link = mail.extractLink(m, /https?:\/\/[^\s"'<>]+token=[^\s"'<>&]+/)
const magic = mail.lastMagicLinkFor('user@example.com')  // convenience
mail.clear()
```

The buffer is a ring (`maxSize` defaults to 100; oldest entries drop). `waitFor` polls until a matching mail arrives or the timeout (`5000` ms by default) elapses — useful when the send happens in a queued job or async middleware.
