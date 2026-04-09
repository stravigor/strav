# Core — Application, Service Providers & DI Container

The core module provides the Application lifecycle manager, the Service Provider pattern, the IoC container, and the `@inject` decorator. Together they form the backbone of Strav's dependency injection and bootstrap system.

## The Container

The `Container` class manages service registration and resolution. Services can be registered as **singletons** (one shared instance) or **transient** (new instance per resolution).

```typescript
import { Container } from '@strav/kernel'

const app = new Container()
```

### Registering services

```typescript
// Singleton — same instance every time
app.singleton(Database)
app.singleton(Logger)
app.singleton(UserService)

// Transient — new instance every time
app.register(RequestContext)

// String-keyed with factory function
app.singleton('mailer', (container) => {
  const config = container.resolve(Configuration)
  return new Mailer(config.get('mail.host'))
})

// Chaining
const app = new Container()
  .singleton(Database)
  .singleton(Logger)
  .singleton(UserService)
```

### Resolving services

```typescript
// By class
const db = app.resolve(Database)

// By string name
const mailer = app.resolve<Mailer>('mailer')

// Check existence
app.has(Database)    // true
app.has('missing')   // false
```

### Auto-wiring

When a class is decorated with `@inject`, the container reads its constructor parameter types via `reflect-metadata` and automatically resolves them. No manual wiring needed:

```typescript
@inject
class UserService {
  constructor(
    private db: Database,      // auto-resolved
    private logger: Logger,    // auto-resolved
  ) {}
}

app.singleton(Database)
app.singleton(Logger)
app.singleton(UserService)

const svc = app.resolve(UserService) // db and logger are injected
```

## The @inject decorator

Mark any class with `@inject` to make it eligible for auto-wiring:

```typescript
import { inject } from '@strav/kernel'

@inject
class PaymentService {
  constructor(private db: Database) {}
}
```

The decorator works both as `@inject` and `@inject()`. It sets internal metadata that the container checks during resolution.

## The global app container

A pre-created singleton container is exported for convenience:

```typescript
import { app } from '@strav/kernel'

app.singleton(Database)
const db = app.resolve(Database)
```

## Instantiating without registration

`make()` creates an instance with full DI auto-wiring but without requiring prior registration. Dependencies are resolved recursively: registered services come from the container, unregistered `@inject` classes are instantiated via `make()` as well.

```typescript
@inject
class NotificationService {
  constructor(private mailer: Mailer) {}
}

// Mailer is registered, NotificationService is not
app.singleton(Mailer)

// make() resolves Mailer from the container, instantiates NotificationService
const svc = app.make(NotificationService)
```

This is used internally by `router.resource()` and `[Controller, 'method']` tuples to resolve controllers without explicit registration.

## Key rules

- All constructor dependencies must themselves be registered in the container (or be `make()`-able) before the dependent service is resolved.
- Singleton instances are created lazily — on first `resolve()`, not on `singleton()`.
- Circular dependencies are not handled — they will cause a stack overflow.

## Application

The `Application` class extends `Container` with service provider lifecycle management. It is the primary way to bootstrap a Strav application — registering providers, booting them in dependency order, and handling graceful shutdown.

```typescript
import { app } from '@strav/kernel'
import {
  ConfigProvider, DatabaseProvider, AuthProvider,
  SessionProvider, CacheProvider, MailProvider,
  QueueProvider, HttpProvider,
} from '@strav/kernel'
import User from './app/models/user'

app
  .use(new ConfigProvider())
  .use(new DatabaseProvider())
  .use(new AuthProvider({ resolver: (id) => User.find(id) }))
  .use(new SessionProvider())
  .use(new CacheProvider())
  .use(new MailProvider())
  .use(new QueueProvider())
  .use(new HttpProvider())

await app.start()
// Server is running. Graceful shutdown on SIGINT/SIGTERM is automatic.
```

Since `Application` extends `Container`, all DI methods (`singleton`, `resolve`, `register`, `make`, `has`) continue to work unchanged.

### Registration order doesn't matter

Providers declare their dependencies via the `dependencies` property. The application uses topological sort (Kahn's algorithm) to boot them in the correct order — regardless of the order you call `use()`:

```typescript
// These two are equivalent:
app.use(new AuthProvider()).use(new DatabaseProvider()).use(new ConfigProvider())
app.use(new ConfigProvider()).use(new DatabaseProvider()).use(new AuthProvider())
// Both boot in order: config → database → auth
```

### Lifecycle

`app.start()` runs two phases in dependency order:

1. **Register** — calls `provider.register(app)` on all providers (synchronous, binds factories into the container)
2. **Boot** — calls `provider.boot(app)` on all providers (async, initializes services)

If a provider's `boot()` throws, all previously booted providers are shut down in reverse order (rollback), and the error is re-thrown.

### Graceful shutdown

`app.start()` installs `SIGINT` and `SIGTERM` signal handlers automatically. On signal:

1. `app.shutdown()` is called
2. Providers are shut down in **reverse boot order** (e.g., HTTP server stops first, database closes last)
3. A 30-second timeout forces exit if providers don't finish

Lifecycle events are emitted via `Emitter`:

| Event | When |
|-------|------|
| `app:starting` | Before the register phase |
| `app:booted` | After all providers are booted |
| `app:shutdown` | Shutdown initiated |
| `app:terminated` | After all providers are shut down |

### Application API

```typescript
app.use(provider)     // add a provider (before start)
await app.start()     // register + boot all providers
await app.shutdown()  // graceful shutdown (reverse order)
app.isBooted          // true after start() completes
app.isShuttingDown    // true during shutdown
```

## Service Providers

A service provider encapsulates the full lifecycle of a framework service: registration (binding into the container), booting (async initialization), and shutdown (cleanup).

```typescript
import { ServiceProvider } from '@strav/kernel'
import type { Application } from '@strav/kernel'
```

### Anatomy of a provider

```typescript
class MyProvider extends ServiceProvider {
  readonly name = 'my-service'              // unique identifier
  readonly dependencies = ['config']         // boot after these providers

  register(app: Application): void {
    app.singleton(MyService)                 // bind into container
  }

  async boot(app: Application): Promise<void> {
    const svc = app.resolve(MyService)       // resolve and initialize
    await svc.connect()
  }

  async shutdown(app: Application): Promise<void> {
    const svc = app.resolve(MyService)
    await svc.disconnect()                   // clean up
  }
}
```

| Method | Phase | Description |
|--------|-------|-------------|
| `register()` | Synchronous | Bind factories/singletons into the container |
| `boot()` | Async | Resolve services, run async initialization (load config, create tables, connect) |
| `shutdown()` | Async | Clean up resources (close connections, stop servers) |

### Writing a custom provider

Extend `ServiceProvider`, set `name` and optionally `dependencies`, and implement the lifecycle methods you need:

```typescript
import { ServiceProvider } from '@strav/kernel'
import type { Application } from '@strav/kernel'

class RedisProvider extends ServiceProvider {
  readonly name = 'redis'
  readonly dependencies = ['config']

  register(app: Application): void {
    app.singleton('redis', () => new Redis(app.resolve(Configuration).get('redis')))
  }

  boot(app: Application): void {
    app.resolve('redis') // trigger lazy creation
  }

  async shutdown(app: Application): Promise<void> {
    await app.resolve('redis').quit()
  }
}
```

### Built-in providers

All built-in providers are exported from `@strav/kernel`:

| Provider | Name | Dependencies | What it does |
|----------|------|-------------|--------------|
| `ConfigProvider` | `config` | — | Loads `Configuration` from config directory |
| `DatabaseProvider` | `database` | `config` | Registers `Database`, closes on shutdown |
| `EncryptionProvider` | `encryption` | `config` | Registers `EncryptionManager` |
| `LoggerProvider` | `logger` | `config` | Registers `Logger` |
| `CacheProvider` | `cache` | `config` | Registers `CacheManager` |
| `StorageProvider` | `storage` | `config` | Registers `StorageManager` |
| `AuthProvider` | `auth` | `database` | Registers `Auth`, sets user resolver, creates tables |
| `SessionProvider` | `session` | `database` | Registers `SessionManager`, creates table |
| `MailProvider` | `mail` | `config` | Registers `MailManager` |
| `QueueProvider` | `queue` | `database` | Registers `Queue`, creates tables |
| `NotificationProvider` | `notification` | `database` | Registers `NotificationManager`, creates table |
| `I18nProvider` | `i18n` | `config` | Registers `I18nManager`, loads translations |
| `BroadcastProvider` | `broadcast` | — | Boots `BroadcastManager` on the router |
| `HttpProvider` | `http` | `config` | Registers `Server`, starts HTTP server, stops on shutdown |

External packages provide their own providers:

| Package | Provider | Name | Dependencies |
|---------|----------|------|-------------|
| `@strav/search` | `SearchProvider` | `search` | `config` |
| `@strav/devtools` | `DevtoolsProvider` | `devtools` | `database` |
| `@strav/brain` | `BrainProvider` | `brain` | `config` |
| `@strav/stripe` | `StripeProvider` | `stripe` | `database` |
| `@strav/social` | `SocialProvider` | `social` | `database` |

### Provider options

Providers that need user input accept options in their constructor:

```typescript
new ConfigProvider({ directory: './config' })
new AuthProvider({ resolver: (id) => User.find(id), ensureTables: true })
new SessionProvider({ ensureTable: true })
new QueueProvider({ ensureTables: true })
new NotificationProvider({ ensureTable: true })
new BroadcastProvider({ middleware: [session()], path: '/_broadcast' })
```

## Full bootstrap example

```typescript
// index.ts
import { app } from '@strav/kernel'
import { router } from '@strav/http'
import {
  ConfigProvider, DatabaseProvider, EncryptionProvider,
  LoggerProvider, CacheProvider, StorageProvider,
  AuthProvider, SessionProvider, MailProvider,
  QueueProvider, NotificationProvider, I18nProvider,
  BroadcastProvider, HttpProvider,
} from '@strav/kernel'
import { SearchProvider } from '@strav/search'
import { DevtoolsProvider } from '@strav/devtools'
import { session } from '@strav/http'
import { auth } from '@strav/http'
import User from './app/models/user'

// Register providers
app
  .use(new ConfigProvider())
  .use(new DatabaseProvider())
  .use(new EncryptionProvider())
  .use(new LoggerProvider())
  .use(new CacheProvider())
  .use(new StorageProvider())
  .use(new AuthProvider({ resolver: (id) => User.find(id) }))
  .use(new SessionProvider())
  .use(new MailProvider())
  .use(new QueueProvider())
  .use(new NotificationProvider())
  .use(new I18nProvider())
  .use(new BroadcastProvider({ middleware: [session()] }))
  .use(new SearchProvider())
  .use(new DevtoolsProvider())
  .use(new HttpProvider())

// Define routes
router.get('/health', (ctx) => ctx.json({ status: 'ok' }))

router.group({ prefix: '/api', middleware: [session(), auth()] }, (r) => {
  r.get('/users', listUsers)
})

// Boot everything
await app.start()
```
