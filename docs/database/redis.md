# Redis

`@strav/database` ships a thin `Redis` wrapper around `Bun.RedisClient` plus two Redis-backed services that sit on top of it:

- **`RedisSessionStore`** — Redis implementation of the `SessionStore` interface consumed by `@strav/http` (see [session guide](../http/session.md)).
- The raw `Redis` client is exposed for your own use (caching, rate limiting, job queues, etc.).

The client is optional — you only need to register `RedisProvider` when at least one Redis-backed service is in use.

## Setup

### Using a service provider (recommended)

```typescript
import { RedisProvider } from '@strav/database'

app.use(new RedisProvider())
```

`RedisProvider` registers `Redis` as a singleton, connects on boot, and closes the connection on shutdown. It depends on the `config` provider.

### Manual setup

```typescript
import { Redis } from '@strav/database'

app.singleton(Redis)
const redis = app.resolve(Redis)
await redis.connect()
```

## Configuration

```typescript
// config/redis.ts
import { env } from '@strav/kernel'

export default {
  // Use a URL if provided — wins over individual fields
  url: env('REDIS_URL', null),

  // Or set individual fields
  host: env('REDIS_HOST', '127.0.0.1'),
  port: env.int('REDIS_PORT', 6379),
  password: env('REDIS_PASSWORD', ''),
  db: env.int('REDIS_DB', 0),
}
```

If none of the keys are set, the client defaults to `redis://127.0.0.1:6379/0`.

## Using the client

```typescript
import { Redis } from '@strav/database'

const redis = app.resolve(Redis)

await redis.client.set('greeting', 'hello')
await redis.client.setex('ephemeral', 60, 'value')

const greeting = await redis.client.get('greeting')
await redis.client.del('greeting')
```

`redis.client` returns the underlying [`Bun.RedisClient`](https://bun.sh/docs/api/redis). All of its methods (`get`, `set`, `setex`, `expire`, `hset`, `hgetall`, `zadd`, `publish`, `subscribe`, `send(...)`, etc.) are available.

### Global accessor

After `RedisProvider` has booted you can also use the static accessor — handy for code paths that don't have DI access:

```typescript
import { Redis } from '@strav/database'

await Redis.raw.set('key', 'value')
```

It throws `ConfigurationError` if called before `RedisProvider` resolves `Redis`.

## Session store

Pair `RedisProvider` with `SessionProvider({ driver: 'redis' })` to put sessions on Redis:

```typescript
import { RedisProvider } from '@strav/database'
import { SessionProvider } from '@strav/http'

app
  .use(new RedisProvider())
  .use(new SessionProvider({ driver: 'redis' }))
```

`RedisSessionStore` serializes each `SessionRecord` as JSON under `strav:session:<uuid>` with a TTL synced to `session.lifetime` (minutes → seconds). Redis evicts expired keys natively, so `SessionManager.gc()` is a no-op. See the [session guide](../http/session.md) for the full API.

## Shutdown

`RedisProvider` closes the client automatically on `SIGINT` / `SIGTERM` via the application's graceful shutdown hook. For manual cleanup:

```typescript
redis.close()
```
