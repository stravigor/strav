# HTTP

The HTTP module provides routing, middleware, request/response helpers, and a Bun.serve() wrapper with WebSocket support.

## Quick start

```typescript
import { router } from '@strav/core/http'

router.get('/health', (ctx) => ctx.json({ status: 'ok' }))

router.group({ prefix: '/api' }, (r) => {
  r.get('/users', listUsers)
  r.post('/users', createUser)
  r.get('/users/:id', showUser)
})
```

The `router` is a singleton resolved from the DI container — import it directly from `'@strav/core/http'`.

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
import type { Middleware } from '@strav/core/http'

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
import { ApiRouting } from '@strav/core/generators'

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
import { HttpProvider } from '@strav/core/providers'

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
import { serializeCookie, parseCookies, withCookie, clearCookie } from '@strav/core/http'

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
import { rateLimit } from '@strav/core/http'

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
import type { RateLimitStore, RateLimitInfo } from '@strav/core/http'

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
import { Resource } from '@strav/core/http'

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
