# HTTP

The HTTP module provides routing, middleware, request/response helpers, and a Bun.serve() wrapper with WebSocket support.

## Quick start

```typescript
import { router } from '@strav/http'

router.get('/health', (ctx) => ctx.json({ status: 'ok' }))

router.group({ prefix: '/api' }, (r) => {
  r.get('/users', listUsers)
  r.post('/users', createUser)
  r.get('/users/:id', showUser)
})
```

The `router` is a singleton resolved from the DI container — import it directly from `'@strav/http'`.

## Context

Every handler receives a `Context` — the single object you interact with for reading the request and building a response.

### Request helpers

```typescript
router.get('/search', async (ctx) => {
  ctx.method                    // 'GET'
  ctx.path                      // '/search'
  ctx.params.id                 // route params (from :id patterns)
  ctx.query.get('q')            // query string params
  ctx.header('Authorization')   // read a header
  ctx.cookie('session_id')      // read a cookie by name
  ctx.subdomain                 // extracted from Host header
  ctx.request                   // the raw Bun Request (always accessible)

  const data = await ctx.body<{ name: string }>()  // auto-parse JSON/form/text
})
```

Body parsing detects the content type automatically:
- `application/json` — parsed as JSON.
- `multipart/form-data` / `application/x-www-form-urlencoded` — parsed as FormData.
- Everything else — returned as text.

The body is cached, so calling `ctx.body()` multiple times is safe.

### Query string

Read query parameters with typed defaults:

```typescript
ctx.qs('page')          // string | null
ctx.qs('page', 1)       // number (parsed, falls back to default if invalid/missing)
ctx.qs('search', '')     // string
```

### Form inputs

Extract string fields from a form body. Avoids repetitive `form.get('x') as string ?? ''` casting:

```typescript
const { name, email, password } = await ctx.inputs('name', 'email', 'password')
// All values are strings, '' if missing
```

With no arguments, returns all non-file fields:

```typescript
const allFields = await ctx.inputs()
```

### File uploads

Extract file fields from a form body:

```typescript
const { avatar } = await ctx.files('avatar')
// avatar is File | null
```

With no arguments, returns all file fields:

```typescript
const allFiles = await ctx.files()
```

For validated uploads with size/type checks, see the [Storage](storage.md) guide.

### Response helpers

Every method returns a standard `Response`:

```typescript
ctx.json({ users: [] })              // 200 JSON
ctx.json({ error: 'nope' }, 404)     // custom status
ctx.text('hello')                    // 200 plain text
ctx.html('<h1>Hi</h1>')             // 200 HTML
ctx.redirect('/login')               // 302 redirect
ctx.redirect('/new-url', 301)        // permanent redirect
ctx.empty()                          // 204 no content
```

### State (middleware data passing)

```typescript
// In middleware
ctx.set('user', { id: 42, name: 'Alice' })

// In handler
const user = ctx.get<{ id: number; name: string }>('user')
```

## Router

### Route methods

```typescript
router.get('/path', handler)
router.post('/path', handler)
router.put('/path', handler)
router.patch('/path', handler)
router.delete('/path', handler)
router.head('/path', handler)
router.options('/path', handler)
```

### Route parameters

```typescript
// Named parameters
router.get('/users/:id', (ctx) => {
  ctx.params.id   // '42'
})

// Multiple parameters
router.get('/users/:userId/posts/:postId', (ctx) => {
  ctx.params.userId    // '5'
  ctx.params.postId    // '99'
})

// Wildcard catch-all
router.get('/files/*path', (ctx) => {
  ctx.params.path   // 'docs/readme.md'
})
```

### Route groups

Groups share a prefix and/or middleware:

```typescript
router.group({ prefix: '/api/v1', middleware: [auth] }, (r) => {
  r.get('/users', listUsers)       // /api/v1/users
  r.post('/users', createUser)     // /api/v1/users

  // Groups nest
  r.group({ prefix: '/admin', middleware: [adminOnly] }, (r) => {
    r.get('/stats', showStats)     // /api/v1/admin/stats
  })
})
```

Group middleware does not leak to routes outside the group. Nested groups accumulate middleware — inner middleware runs after outer middleware.

#### Group aliases

Groups can be assigned aliases for hierarchical route naming. When groups have aliases, routes inside them automatically inherit the full alias chain:

```typescript
router.group({ prefix: '/api' }, (r) => {
  router.group({ prefix: '/users' }, (r) => {
    r.get('', listUsers).as('index')       // Route name: 'api.users.index'
    r.post('', createUser).as('create')    // Route name: 'api.users.create'
    r.get('/:id', showUser).as('show')     // Route name: 'api.users.show'
  }).as('users')

  router.group({ prefix: '/posts' }, (r) => {
    r.get('', listPosts).as('index')       // Route name: 'api.posts.index'
    r.post('', createPost).as('create')    // Route name: 'api.posts.create'
  }).as('posts')
}).as('api')
```

The group alias is optional and backward compatible. Groups without aliases work as before, and you can mix aliased and non-aliased groups:

```typescript
router.group({ prefix: '/v1' }, (r) => {
  // This group has no alias
  router.group({ prefix: '/public' }, (r) => {
    r.get('/info', info).as('info')        // Route name: 'v1.info'
  })

  // This group has an alias
  router.group({ prefix: '/auth' }, (r) => {
    r.post('/login', login).as('login')    // Route name: 'v1.auth.login'
    r.post('/logout', logout).as('logout') // Route name: 'v1.auth.logout'
  }).as('auth')
}).as('v1')
```

### Subdomain routing

```typescript
router.setDomain('example.com')

// Static subdomain
router.subdomain('api', (r) => {
  r.get('/data', apiData)          // api.example.com/data
})

// Dynamic subdomain (wildcard)
router.subdomain(':tenant', (r) => {
  r.get('/dashboard', dashboard)   // acme.example.com/dashboard
                                   // ctx.params.tenant === 'acme'
})
```

Routes without a subdomain constraint match regardless of subdomain.

### Resource routes

Register a full set of RESTful routes for a controller. Pass a class constructor — the router resolves it via `app.make()` with automatic dependency injection:

```typescript
import UserController from './app/http/controllers/user_controller'

router.resource('/users', UserController)
```

This registers:

| Method | Path | Handler | Purpose |
|--------|------|---------|---------|
| GET | `/users` | `index` | List all |
| POST | `/users` | `store` | Create |
| GET | `/users/:id` | `show` | Show one |
| PUT | `/users/:id` | `update` | Full update |
| PATCH | `/users/:id` | `update` | Partial update |
| DELETE | `/users/:id` | `destroy` | Delete |

Only routes for methods that exist on the controller are registered. If your controller only has `index` and `show`, the other routes won't be created.

You can also pass an object instance directly:

```typescript
// Object literal — only list and view
const readOnlyController = {
  index: (ctx) => ctx.json(items),
  show:  (ctx) => ctx.json(items.find(ctx.params.id)),
}
router.resource('/items', readOnlyController)
// Only GET /items and GET /items/:id are registered
```

Apply middleware to all resource routes:

```typescript
router.resource('/users', UserController, [auth, rateLimit])
```

#### `.only()` — restrict actions

Limit a resource to a subset of actions:

```typescript
router.resource('/posts', PostController).only(['index', 'show'])
// GET /posts       → index
// GET /posts/:id   → show
// (no store, update, or destroy)
```

#### `.singleton()` — no `:id` param

Register a singleton resource with `show`, `update`, and `destroy` routes — without the `/:id` suffix. Useful for configuration-style schemas where a single record belongs to the parent:

```typescript
router.group({ prefix: '/posts/:parentId' }, (r) => {
  r.resource('/settings', PostSettingController).singleton()
  // GET    /posts/:parentId/settings   → show
  // PUT    /posts/:parentId/settings   → update
  // PATCH  /posts/:parentId/settings   → update
  // DELETE /posts/:parentId/settings   → destroy
})
```

Resource routes work inside groups:

```typescript
router.group({ prefix: '/api/v1' }, (r) => {
  r.resource('/users', UserController)
  // GET /api/v1/users, POST /api/v1/users, etc.
})
```

### Controller–method tuples

For individual routes, pass a `[Controller, 'method']` tuple. The controller is resolved via DI automatically:

```typescript
import PostSettingController from './app/http/controllers/post_setting_controller'

router.group({ prefix: '/posts/:parentId' }, (r) => {
  r.get('/settings', [PostSettingController, 'show'])
  r.put('/settings', [PostSettingController, 'update'])
  r.delete('/settings', [PostSettingController, 'destroy'])
})
```

This is useful when a controller's routes don't follow the standard resource pattern (e.g., configuration archetypes that use `parentId` instead of `:id`).

### Named routes

```typescript
router.get('/users/:id', showUser).as('users.show')
```

Named routes can be used with the route helper functions for transparent route invocation.

## Route Helpers

The HTTP module provides `route()` and `routeUrl()` helper functions that enable transparent route invocation using named routes. These helpers eliminate hardcoded URLs and provide automatic method detection, smart header defaults, and type safety.

### Browser-safe imports

For client-side usage (browser bundles), import from `@strav/view` to avoid Node.js dependencies:

```typescript
// ✅ Browser-safe import (avoids Node.js modules)
import { route, routeUrl, registerRoutes } from '@strav/view'

// ❌ Server import (includes Node.js dependencies that break browser bundlers)
import { route, routeUrl } from '@strav/http'
```

The `@strav/view` package provides browser-safe route helpers that work independently of the server-side router instance.

#### Automatic route injection during build

Route definitions are **automatically injected** when you build islands using the `buildWithRoutes()` method:

```typescript
import { router } from '@strav/http'
import { IslandBuilder } from '@strav/view'

const builder = new IslandBuilder({
  islandsDir: './resources/islands',
  outDir: './public/builds',
  // CSS and other options work normally
  css: { entry: 'resources/scss/index.scss' }
})

await builder.buildWithRoutes(router)  // Routes automatically injected!
```

Then in your templates, just use the `@islands()` directive as normal:

```html
<!-- In your .strav template -->
@islands()  <!-- Islands bundle now includes route definitions! -->
```

Now client-side code can use route helpers without any setup:

```typescript
import { route, routeUrl } from '@strav/view'

// Route definitions are already available - no registerRoutes() needed!
const userUrl = routeUrl('users.show', { id: 123 })  // '/users/123'
const response = await route('users.create', { name: 'John', email: 'john@example.com' })
```

#### Manual route registration (optional)

For cases where you're not using islands or need custom route definitions:

```typescript
import { registerRoutes, route, routeUrl } from '@strav/view'

// Only needed if not using @islands() directive
registerRoutes({
  'users.show': { method: 'GET', pattern: '/users/:id' },
  'users.create': { method: 'POST', pattern: '/users' }
})
```

### Invoking named routes with `route()`

The `route()` function makes HTTP requests to named routes with automatic configuration:

```typescript
import { route } from '@strav/view'  // Browser-safe client import

// Simple POST with JSON body (auto-detected)
const response = await route('api.v1.auth.register', {
  name: 'Jane Smith',
  email: 'jane@example.com',
  password: 'secure_password',
  terms_accepted: true
})

// GET request with URL parameters
const response = await route('users.show', {
  params: { id: 123 }
})

// PUT request with params and body
const response = await route('users.update', {
  params: { id: 123 },
  body: { name: 'Updated Name', email: 'new@example.com' }
})

// File upload with FormData
const formData = new FormData()
formData.append('file', fileInput.files[0])
formData.append('description', 'Profile photo')

const response = await route('api.upload', formData)

// Custom headers and options
const response = await route('api.data', {
  headers: {
    'Authorization': 'Bearer token',
    'X-Custom-Header': 'value'
  },
  cache: 'no-cache',
  credentials: 'include'
})
```

#### Automatic defaults

The `route()` function provides smart defaults:

- **Method detection**: Automatically uses the HTTP method from the route definition
- **Headers**:
  - `Accept: application/json` by default
  - `Content-Type: application/json` for object bodies
  - `Content-Type: multipart/form-data` for FormData (set by browser)
  - No Content-Type header for Blob/ArrayBuffer/URLSearchParams
- **Credentials**: `same-origin` by default

All defaults can be overridden by passing custom options.

### Generating URLs with `routeUrl()`

The `routeUrl()` function generates URLs from named routes:

```typescript
import { routeUrl } from '@strav/view'  // Browser-safe client import

// Generate simple URL
const homeUrl = routeUrl('public.home')  // '/'

// Generate URL with parameters
const profileUrl = routeUrl('users.show', { id: 456 })  // '/users/456'

// Generate URL with query parameters
const searchUrl = routeUrl('api.search', {
  q: 'typescript',    // Added as query param
  page: 2            // Added as query param
})  // '/api/search?q=typescript&page=2'

// Mixed route params and query params
const filteredUserUrl = routeUrl('users.posts', {
  id: 123,           // Route param (replaces :id)
  category: 'tech',  // Query param
  sort: 'recent'     // Query param
})  // '/users/123/posts?category=tech&sort=recent'
```

### Generating full URLs with `routeFullUrl()`

The `routeFullUrl()` function generates complete URLs with protocol and domain:

```typescript
import { routeFullUrl } from '@strav/http'  // Server-side import

// With APP_URL environment variable set
const resetUrl = routeFullUrl('auth.password.reset', { token: 'abc123' })
// Returns 'https://example.com/auth/password-reset?token=abc123'

// Using request context (auto-detects origin)
router.get('/share', (ctx) => {
  const shareUrl = routeFullUrl('posts.show', { id: 42 }, ctx)
  // Returns 'https://myapp.com/posts/42' based on request origin

  return ctx.json({ share_url: shareUrl })
})

// Override with custom base URL
const apiUrl = routeFullUrl('api.webhook', {}, null, 'https://api.external.com')
// Returns 'https://api.external.com/api/webhook'
```

#### Configuration

Set the `APP_URL` in your environment or configure it in `config/http.ts`:

```typescript
// config/http.ts
export default {
  // ... other config
  app_url: env('APP_URL', 'https://myapp.com'),
}
```

Or let it be constructed automatically from your HTTP config:

```typescript
// .env
DOMAIN=myapp.com
PORT=443
SECURE=true  // or configure http.secure in config
```

#### Context origin detection

The `Context` class provides a `getOrigin()` method that intelligently detects the request origin:

```typescript
router.get('/api/info', (ctx) => {
  const origin = ctx.getOrigin()
  // Returns 'https://api.myapp.com' (from Host header and X-Forwarded-Proto)

  return ctx.json({
    origin,
    callback_url: routeFullUrl('api.callback', {}, ctx)
  })
})
```

The method handles:
- `X-Forwarded-Proto` header (when behind proxies/load balancers)
- `Host` header with proper port handling
- HTTPS/HTTP protocol detection

#### Use cases for full URLs

Full URLs are essential for:
- **Email links**: Password resets, email verification, notifications
- **OAuth callbacks**: Return URLs for external authentication
- **Webhooks**: Callback URLs for external services
- **API documentation**: Showing complete endpoint URLs
- **Social sharing**: Open Graph URLs, share links
- **External redirects**: Redirecting to full URLs from emails or external systems

### Working with hierarchical group aliases

Route helpers work seamlessly with the group alias system:

```typescript
// Define routes with hierarchical aliases
router.group({ prefix: '/api' }, (r) => {
  r.group({ prefix: '/v1' }, (r) => {
    r.group({ prefix: '/auth' }, (r) => {
      r.post('/register', registerHandler).as('register')
      r.post('/login', loginHandler).as('login')
      r.post('/logout', logoutHandler).as('logout')
    }).as('auth')

    r.group({ prefix: '/users' }, (r) => {
      r.get('', listUsers).as('index')
      r.get('/:id', showUser).as('show')
      r.put('/:id', updateUser).as('update')
      r.delete('/:id', deleteUser).as('delete')
    }).as('users')
  }).as('v1')
}).as('api')

// Use the full hierarchical names
await route('api.v1.auth.register', userData)
await route('api.v1.users.show', { params: { id: 123 } })
const url = routeUrl('api.v1.users.index')  // '/api/v1/users'
```

### Error handling

Route helpers provide clear error messages:

```typescript
try {
  // Throws if route doesn't exist
  await route('non.existent.route', {})
} catch (error) {
  console.error(error.message)  // "Route 'non.existent.route' not found"
}

try {
  // Throws if required parameter is missing
  routeUrl('users.show')  // Missing 'id' parameter
} catch (error) {
  console.error(error.message)  // "Missing required parameter 'id' for route 'users.show'"
}
```

### Advanced usage

```typescript
// Override the detected method
await route('users.index', { method: 'HEAD' })

// Send plain text instead of JSON
await route('api.message', {
  body: 'Plain text message',
  headers: { 'Content-Type': 'text/plain' }
})

// Use with async/await error handling
const result = await route('api.data', {})
  .then(res => res.json())
  .catch(err => console.error('Request failed:', err))

// Check response status
const response = await route('users.create', userData)
if (!response.ok) {
  const error = await response.json()
  console.error('Creation failed:', error)
}
```

### TypeScript support

The route helpers are fully typed:

```typescript
import type { RouteOptions } from '@strav/http'

// Type-safe options
const options: RouteOptions = {
  params: { id: 123 },
  headers: { 'X-Custom': 'value' },
  cache: 'no-store'
}

const response = await route('users.show', options)
```

### Benefits

Using route helpers provides several advantages:

1. **No hardcoded URLs**: All URLs are generated from route definitions
2. **Automatic configuration**: Method, headers, and body handling are automatic
3. **Centralized routing**: Route changes only need to be made in one place
4. **Refactoring-friendly**: Rename routes without breaking client code
5. **Type safety**: Routes are validated at runtime (with TypeScript support)
6. **Clean API**: Simple, intuitive syntax for all HTTP operations
7. **Framework integration**: Works seamlessly with groups, aliases, and middleware

### Global middleware

```typescript
router.use(logger)
router.use(cors)
// Runs on every request, before group/route middleware
```

## Middleware

A middleware is just a function:

```typescript
type Middleware = (ctx: Context, next: Next) => Response | Promise<Response>
```

### Writing middleware

```typescript
import type { Middleware } from '@strav/http'

const logger: Middleware = async (ctx, next) => {
  const start = performance.now()
  const response = await next()
  console.log(`${ctx.method} ${ctx.path} — ${(performance.now() - start).toFixed(1)}ms`)
  return response
}

const auth: Middleware = async (ctx, next) => {
  const token = ctx.header('Authorization')
  if (!token) return ctx.json({ error: 'Unauthorized' }, 401)
  ctx.set('user', await verifyToken(token))
  return next()
}
```

### Middleware pipeline (onion model)

Middleware wraps the next layer. Execution flows inward, then outward:

```
Request → logger → auth → handler → auth → logger → Response
```

Call `next()` to pass to the next layer. Skip `next()` to short-circuit (e.g., return a 401 without reaching the handler).

## WebSocket

WebSocket routes are co-located with HTTP routes:

```typescript
router.ws('/chat', {
  open(ws) {
    ws.send('welcome')
  },
  message(ws, data) {
    ws.send(data)  // echo
  },
  close(ws) {
    // cleanup
  },
})
```

The upgrade from HTTP to WebSocket happens automatically when a matching WebSocket route is hit.

## Server

The `Server` class is `@inject`-able and reads from `config/http.ts`:

```typescript
// config/http.ts
import { ApiRouting } from '@strav/cli'

export default {
  host: env('HTTP_HOST', '0.0.0.0'),
  port: env.int('HTTP_PORT', 3000),
  domain: env('APP_DOMAIN', 'localhost'),

  api: {
    routing: ApiRouting.Prefix,
    prefix: '/api',
    subdomain: 'api',
  },
}
```

### Using a service provider (recommended)

```typescript
import { HttpProvider } from '@strav/http'

app.use(new HttpProvider())
```

The `HttpProvider` registers `Server` and `Router` as singletons, starts the HTTP server on boot, and stops it on shutdown. It depends on the `config` provider. Place it last in your provider list since it starts accepting requests.

### Manual setup

```typescript
app.singleton(Server)
const server = app.resolve(Server)
server.start(router)   // starts Bun.serve()
server.stop()          // graceful shutdown
```

The `domain` setting is used for subdomain extraction from the `Host` header. The `api` section controls how `generate:api` wires routes — see the [generators guide](generators.md#api-routing-mode) for details.

## Cookie helpers

Low-level cookie utilities are available for building custom cookie logic:

```typescript
import { serializeCookie, parseCookies, withCookie, clearCookie } from '@strav/http'

// Serialize a Set-Cookie header string
const header = serializeCookie('theme', 'dark', {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  maxAge: 86400,
  path: '/',
})

// Parse a Cookie request header into a Map
const cookies = parseCookies('sid=abc; theme=dark')
cookies.get('sid')   // 'abc'

// Add a Set-Cookie header to an existing Response
const res = withCookie(response, 'theme', 'dark', { path: '/' })

// Expire a cookie (Max-Age=0)
const res = clearCookie(response, 'theme', { path: '/' })
```

In most cases you won't need these directly — the auth module handles session cookies automatically. But they're available for custom use cases like theme preferences or consent banners.

## CORS

CORS is handled at the router level — not as middleware. This is because OPTIONS preflight requests don't match any registered route method, so they'd get a 404 before middleware could run.

### Setup

```typescript
router.cors({ origin: 'https://app.example.com', credentials: true })
```

Call `router.cors()` once during bootstrap (after routes are loaded, before the server starts).

### Options

```typescript
router.cors({
  // Allowed origins — string, array, RegExp, or callback
  origin: 'https://app.example.com',
  origin: ['https://app.example.com', 'https://admin.example.com'],
  origin: /\.example\.com$/,
  origin: (origin) => allowedOrigins.has(origin),
  origin: '*',                  // default — allow all

  methods: ['GET', 'POST'],    // default: GET, HEAD, PUT, PATCH, POST, DELETE
  allowedHeaders: ['X-Custom'], // default: mirrors request's Access-Control-Request-Headers
  exposedHeaders: ['X-Request-Id'],
  credentials: true,            // default: false
  maxAge: 86400,                // default: 86400 (24h) — preflight cache duration in seconds
})
```

When `credentials: true` and origin is `'*'`, the actual request origin is reflected instead of a literal `*` (as required by the spec).

### How it works

1. **Preflight (OPTIONS):** The router auto-responds with 204 + CORS headers for any path that has at least one registered route (any method). Explicit `router.options()` routes take precedence.
2. **Actual requests:** Every matched route response gets `Access-Control-Allow-Origin` (and related headers) appended automatically.
3. **Non-existent paths:** OPTIONS to a path with no routes returns 404 — no CORS headers are leaked for unknown endpoints.

### Reading from config

```typescript
// config/http.ts
export default {
  // ...existing config...
  cors: {
    origin: env('CORS_ORIGIN', '*'),
    credentials: env.bool('CORS_CREDENTIALS', false),
  },
}

// index.ts
const corsConfig = config.get('http.cors') as CorsOptions | undefined
if (corsConfig) router.cors(corsConfig)
```

## Rate limiting

Rate limiting is a standard middleware — it runs in the normal pipeline after route matching.

### Quick start

```typescript
import { rateLimit } from '@strav/http'

// Global: 100 requests per minute
router.use(rateLimit({ max: 100, window: 60_000 }))
```

### Options

```typescript
rateLimit({
  window: 60_000,       // time window in ms (default: 60_000 = 1 min)
  max: 60,              // max requests per window (default: 60)
  headers: true,        // add X-RateLimit-* headers to responses (default: true)

  // Custom key extraction (default: X-Forwarded-For → X-Real-IP → 'unknown')
  keyExtractor: (ctx) => ctx.header('x-api-key') ?? 'anon',

  // Skip certain requests
  skip: (ctx) => ctx.path === '/health',

  // Custom 429 response
  onLimitReached: (ctx, info) => ctx.json({ error: 'Slow down', retryIn: info.resetTime }, 429),

  // Custom store (default: in-memory fixed-window)
  store: new MyRedisStore(),
})
```

### Per-route rate limiting

Apply stricter limits to sensitive endpoints:

```typescript
router.group({
  prefix: '/auth',
  middleware: [rateLimit({ max: 5, window: 300_000 })],  // 5 attempts per 5 minutes
}, (r) => {
  r.post('/login', loginHandler)
  r.post('/register', registerHandler)
})
```

### Response headers

On successful requests (when `headers: true`):

```
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 58
X-RateLimit-Reset: 1707753660
```

On 429 responses:

```
X-RateLimit-Limit: 60
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1707753660
Retry-After: 42
```

### Custom store

The default `MemoryStore` uses fixed time windows with lazy cleanup — suitable for single-process deployments. For distributed setups, implement the `RateLimitStore` interface:

```typescript
import type { RateLimitStore, RateLimitInfo } from '@strav/http'

class RedisRateLimitStore implements RateLimitStore {
  async increment(key: string, window: number, max: number): Promise<RateLimitInfo> {
    // Your Redis logic here
  }
  async reset(key: string): Promise<void> {
    // Delete the key
  }
}

router.use(rateLimit({ store: new RedisRateLimitStore() }))
```

## API Resources

Resources are lightweight serializers that control the shape of JSON responses. They sit between your models and `ctx.json()`, letting you pick which fields are exposed, add computed fields, and nest related resources.

### Defining a resource

Extend `Resource<T>` and implement `define()`:

```typescript
import { Resource } from '@strav/http'

class UserResource extends Resource<User> {
  define(user: User) {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      createdAt: user.createdAt,
      // password, updatedAt, etc. are excluded
    }
  }
}
```

Fields not returned from `define()` are excluded from the output. `DateTime` values are automatically converted to ISO 8601 strings. `BigInt` values are converted to `Number` (if within safe integer range) or `String` (for large values), preventing `JSON.stringify()` errors.

### Single item

```typescript
const user = await this.service.find(ctx.params.id!)
if (!user) return ctx.json({ error: 'Not Found' }, 404)
return ctx.json(UserResource.make(user))
// { "id": 1, "name": "John", "email": "john@example.com", "createdAt": "2025-06-15T12:00:00.000+00:00" }
```

`make()` returns `null` if the input is `null` or `undefined`.

### Collections

```typescript
const users = await this.service.list()
return ctx.json(UserResource.collection(users))
// [{ "id": 1, ... }, { "id": 2, ... }]
```

### Pagination

Works directly with `PaginationResult` from the query builder:

```typescript
const result = await query(User).paginate(1, 10)
return ctx.json(UserResource.paginate(result))
// { "data": [{ ... }, { ... }], "meta": { "page": 1, "perPage": 10, "total": 42, ... } }
```

### Computed fields

Add derived fields that don't exist on the model:

```typescript
class UserResource extends Resource<User> {
  define(user: User) {
    return {
      id: user.id,
      name: user.name,
      initials: user.name.split(' ').map(n => n[0]).join(''),
      memberSince: user.createdAt.toRelative(),  // "3 months ago"
    }
  }
}
```

### Nested resources

Nest other resources for relationships:

```typescript
class PostResource extends Resource<Post> {
  define(post: Post) {
    return {
      id: post.id,
      title: post.title,
      author: UserResource.make(post.author),          // single relation
      tags: TagResource.collection(post.tags ?? []),    // many relation
    }
  }
}
```

If `post.author` is `null`, the nested resource returns `null`. Empty arrays pass through as `[]`.

### Multiple resources per model

You can define different resources for different contexts:

```typescript
// Public API — minimal info
class PublicUserResource extends Resource<User> {
  define(user: User) {
    return { id: user.id, name: user.name }
  }
}

// Admin API — full details
class AdminUserResource extends Resource<User> {
  define(user: User) {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      createdAt: user.createdAt,
      lastLoginAt: user.lastLoginAt,
    }
  }
}
```
