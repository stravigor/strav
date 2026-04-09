# Cache

In-memory caching with a pluggable store interface, cache-aside helpers, and HTTP response cache headers.

## Setup

### Using a service provider (recommended)

```typescript
import { CacheProvider } from '@strav/kernel'

app.use(new CacheProvider())
```

The `CacheProvider` registers `CacheManager` as a singleton. It depends on the `config` provider.

### Manual setup

```typescript
import { CacheManager } from '@strav/kernel'

app.singleton(CacheManager)
app.resolve(CacheManager)
```

Create `config/cache.ts`:

```typescript
import { env } from '@strav/kernel'

export default {
  default: env('CACHE_DRIVER', 'memory'),
  prefix: env('CACHE_PREFIX', 'app:'),
  ttl: env.int('CACHE_TTL', 3600),
}
```

## Cache helpers

The `cache` object is the primary API. All keys are automatically prefixed with the configured `prefix`.

```typescript
import { cache } from '@strav/kernel'
```

### remember (cache-aside)

The most common pattern — return a cached value or compute and cache it:

```typescript
const user = await cache.remember(`user:${id}`, 300, () => User.find(id))

const stats = await cache.remember('dashboard:stats', 60, async () => {
  const [users, projects] = await Promise.all([User.count(), Project.count()])
  return { users, projects }
})
```

The factory is only called on a cache miss. The result is stored with the given TTL (in seconds).

### rememberForever

Same as `remember` but without expiry:

```typescript
const config = await cache.rememberForever('app:config', () => loadExpensiveConfig())
```

### get / set

```typescript
await cache.set('features', { darkMode: true }, 3600)   // TTL in seconds
await cache.set('features', { darkMode: true })          // uses config default TTL

const features = await cache.get<{ darkMode: boolean }>('features')
// { darkMode: true } or null
```

### has / forget / flush

```typescript
await cache.has('features')     // true
await cache.forget('features')  // remove one key
await cache.flush()             // clear everything
```

## HTTP cache middleware

Sets `Cache-Control`, `ETag`, and `Vary` headers on responses. The browser or CDN does the actual caching — this middleware only controls the headers.

```typescript
import { httpCache } from '@strav/http'
```

### Basic usage

```typescript
router.group({ prefix: '/api/public', middleware: [httpCache({ maxAge: 300 })] }, (r) => {
  r.get('/categories', listCategories)
})
```

### Options

```typescript
httpCache({
  maxAge: 300,                          // Cache-Control max-age in seconds (default: 0)
  sMaxAge: 600,                         // s-maxage for shared caches (CDN)
  directives: ['public'],               // default: ['public']
  etag: true,                           // compute weak ETag from response body (default: false)
  vary: ['Accept-Encoding'],            // Vary header values (default: ['Accept-Encoding'])
  skip: (ctx) => ctx.path === '/health', // bypass for certain requests
})
```

### ETag and 304

When `etag: true`, the middleware computes a weak ETag from an MD5 hash of the response body. If the client sends a matching `If-None-Match` header, a `304 Not Modified` is returned with no body.

```typescript
router.use(httpCache({ maxAge: 60, etag: true }))
```

### Directives

Available directives: `public`, `private`, `no-cache`, `no-store`, `must-revalidate`, `immutable`.

```typescript
// Immutable versioned assets
httpCache({ maxAge: 31536000, directives: ['public', 'immutable'] })

// Private, must revalidate
httpCache({ directives: ['private', 'must-revalidate'], maxAge: 0 })
```

The middleware only applies to GET and HEAD requests — POST/PUT/DELETE responses are passed through unchanged.

## Custom store

The default `MemoryCacheStore` uses a `Map` with lazy TTL eviction — suitable for single-process deployments. For distributed setups, implement the `CacheStore` interface and swap it in:

```typescript
import type { CacheStore } from '@strav/kernel'
import { CacheManager } from '@strav/kernel'

class RedisCacheStore implements CacheStore {
  private redis = new Bun.RedisClient()

  async get<T>(key: string): Promise<T | null> {
    const value = await this.redis.get(key)
    return value ? JSON.parse(value) : null
  }

  async set(key: string, value: unknown, ttl?: number): Promise<void> {
    const serialized = JSON.stringify(value)
    if (ttl) {
      await this.redis.set(key, serialized, 'EX', ttl)
    } else {
      await this.redis.set(key, serialized)
    }
  }

  async has(key: string): Promise<boolean> {
    return (await this.redis.exists(key)) === 1
  }

  async forget(key: string): Promise<void> {
    await this.redis.del(key)
  }

  async flush(): Promise<void> {
    await this.redis.flushdb()
  }
}

// In bootstrap, after resolving CacheManager
CacheManager.useStore(new RedisCacheStore())
```

## Controller example

```typescript
import { cache } from '@strav/kernel'

export default class ProjectController {
  async index(ctx: Context) {
    const org = ctx.get<Organization>('organization')

    const projects = await cache.remember(
      `org:${org.id}:projects`,
      120,
      () => Project.where('organization_id', org.id).all()
    )

    return ctx.json({ projects })
  }

  async update(ctx: Context) {
    const project = ctx.get('resource') as Project
    const data = await ctx.body<Record<string, unknown>>()

    await project.fill(data).save()

    // Invalidate cache after mutation
    await cache.forget(`org:${project.organizationId}:projects`)

    return ctx.json({ project })
  }
}
```
