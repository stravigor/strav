# Flag

Feature flags with a unified API, scoped per-user or per-team, and optional rich values for A/B testing. Built-in drivers for **PostgreSQL** (persistent) and **in-memory** (testing). Custom drivers can be added via `extend()`.

## Installation

```bash
bun add @strav/flag
bun strav install flag
```

The `install` command copies `config/flag.ts` into your project. The file is yours to edit.

## Setup

### 1. Register FlagManager

#### Using a service provider (recommended)

```typescript
import { FlagProvider } from '@strav/flag'

app.use(new FlagProvider())
```

The `FlagProvider` registers `FlagManager` as a singleton. It depends on the `config` and `database` providers, and auto-creates the `_strav_features` table on boot.

To skip auto-creation (e.g. when using migrations):

```typescript
app.use(new FlagProvider({ ensureTables: false }))
```

#### Manual setup

```typescript
import FlagManager from '@strav/flag'

app.singleton(FlagManager)
app.resolve(FlagManager)
await FlagManager.ensureTables()
```

### 2. Configure drivers

Edit `config/flag.ts`:

```typescript
import { env } from '@strav/kernel'

export default {
  default: env('FLAG_DRIVER', 'database'),

  drivers: {
    database: {
      driver: 'database',
    },

    array: {
      driver: 'array',
    },
  },
}
```

## Defining features

Features must be defined before they can be checked. Define them during app bootstrap, after the provider boots.

### Closure-based

```typescript
import { flag } from '@strav/flag'

// Boolean flag
flag.define('new-checkout', true)

// Dynamic — receives the serialized scope key (e.g. "User:42")
flag.define('beta-ui', (scope) => {
  if (scope === '__global__') return false
  const id = parseInt(scope.split(':')[1])
  return id % 10 === 0  // 10% rollout
})

// Rich value for A/B testing
flag.define('checkout-variant', (scope) => {
  const id = parseInt(scope.split(':')[1] ?? '0')
  return id % 2 === 0 ? 'variant-a' : 'variant-b'
})
```

### Class-based

```typescript
import type { FeatureClass } from '@strav/flag'

class NewBillingExperience implements FeatureClass {
  static readonly key = 'new-billing'

  resolve(scope: string) {
    return scope !== '__global__'
  }
}

flag.defineClass(NewBillingExperience)
```

If `key` is not set, the class name is converted to kebab-case (`NewBillingExperience` → `new-billing-experience`).

## Checking features

```typescript
import { flag } from '@strav/flag'

if (await flag.active('new-checkout')) {
  // feature is on
}

if (await flag.inactive('new-checkout')) {
  // feature is off
}

// Rich value
const variant = await flag.value('checkout-variant') as string
```

### Conditional execution

```typescript
const html = await flag.when(
  'new-checkout',
  (value) => renderNewCheckout(value),
  () => renderOldCheckout(),
)
```

The `onActive` callback receives the resolved value. The `onInactive` callback receives no arguments.

### Batch check

```typescript
const values = await flag.values(['new-checkout', 'beta-ui', 'checkout-variant'])
// Map { 'new-checkout' => true, 'beta-ui' => false, 'checkout-variant' => 'variant-a' }
```

## Scoping

By default, features resolve at the global scope. Use `.for()` to scope to a specific entity:

```typescript
const user = ctx.get<User>('user')

await flag.for(user).active('beta-ui')
await flag.for(user).value('checkout-variant')
await flag.for(user).values(['feat-a', 'feat-b'])
```

Any object with an `id` property works as a scope. The scope is serialized as `ClassName:id` (e.g. `User:42`, `Team:7`).

To customize the type prefix, implement `featureScope()`:

```typescript
class Workspace {
  id = 5
  featureScope() { return 'Workspace' }
}
// Serializes to "Workspace:5"
```

### Global scope

When no scope is passed, features resolve against the `__global__` scope. This is useful for system-wide flags like maintenance mode.

## Manual activation

Override the resolver and store a specific value:

```typescript
// Activate for the global scope
await flag.activate('maintenance-mode')

// Activate for a specific user
await flag.for(user).activate('beta-ui')

// Activate with a rich value
await flag.activate('checkout-variant', 'variant-c')

// Deactivate
await flag.deactivate('maintenance-mode')
await flag.for(user).deactivate('beta-ui')
```

### Activate/deactivate for everyone

Shorthand for the global scope:

```typescript
await flag.activateForEveryone('maintenance-mode')
await flag.deactivateForEveryone('maintenance-mode')

// With a rich value
await flag.activateForEveryone('checkout-variant', 'variant-b')
```

### Recording who flipped a flag

`activate`, `deactivate`, and the `forEveryone` variants all accept an optional `actor: { type, id }` parameter. When supplied, the actor is included in the `flag:updated` Emitter event payload alongside the previous stored value:

```typescript
await flag.activate('maintenance-mode', true, null, { type: 'admin', id: '7' })
await flag.for(user).deactivate('beta-ui', { type: 'admin', id: '7' })
```

Apps that want an audit trail of flag changes wire `flag:updated` to `@strav/audit` once at bootstrap:

```typescript
import { Emitter } from '@strav/kernel'
import { audit } from '@strav/audit'

Emitter.on('flag:updated', e => {
  if (!e.actor) return
  audit.by(e.actor)
    .on('feature_flag', e.feature)
    .action(e.value === false ? 'deactivated' : 'activated')
    .diff({ value: e.previous }, { value: e.value })
    .meta({ scope: e.scope })
    .log()
})
```

The flag package deliberately does not depend on `@strav/audit` — wiring is the consumer's choice. Calls without an actor still emit the event with `actor: null`, useful for system-driven flips that don't need attribution.

## Resolution flow

When `flag.value('feature', scope)` is called:

1. **In-memory cache** — return immediately if cached
2. **Store lookup** — check the database for a persisted value
3. **Resolver** — call the closure/class `resolve()` method
4. **Persist** — store the resolved value in the database
5. **Cache** — cache in memory for the rest of the request

The resolver only runs once per feature+scope. After that, the persisted value is returned directly. Use `forget()` to force re-resolution.

## Eager loading

When rendering a list where you check features per-item, eager-load to avoid N+1 queries:

```typescript
const users = await User.all()

await flag.load(['beta-ui', 'checkout-variant'], users)

for (const user of users) {
  // These are now cached — no additional DB queries
  if (await flag.for(user).active('beta-ui')) {
    // ...
  }
}
```

## Cleanup

```typescript
// Remove stored value for the current scope — forces re-resolution on next check
await flag.forget('beta-ui')
await flag.for(user).forget('beta-ui')

// Remove all stored values for a feature (all scopes)
await flag.purge('beta-ui')

// Remove everything
await flag.purgeAll()
```

### Cache flushing

The in-memory cache lives for the duration of the process. Flush it to force a re-read from the database:

```typescript
flag.flushCache()
```

## Middleware

Gate routes behind a feature flag with `ensureFeature()`. Returns a `403` JSON response when the feature is not active.

```typescript
import { ensureFeature } from '@strav/flag'

router.group({ middleware: [auth(), ensureFeature('beta-ui')] }, (r) => {
  r.get('/beta/dashboard', betaDashboard)
})
```

The middleware uses `ctx.get('user')` as the scope by default. Pass a custom scope extractor for other entities:

```typescript
import { compose } from '@strav/http'

r.get('/team/:id/analytics', compose(
  [ensureFeature('team-analytics', (ctx) => ctx.get('team'))],
  analyticsHandler,
))
```

## Events

Feature operations emit events through the `Emitter`:

| Event | Payload | When |
|---|---|---|
| `flag:resolved` | `{ feature, scope, value }` | Value resolved for the first time |
| `flag:updated` | `{ feature, scope, value }` | Value changed via activate/deactivate |
| `flag:deleted` | `{ feature, scope }` | Value forgotten or purged |

```typescript
import Emitter from '@strav/kernel'

Emitter.on('flag:resolved', ({ feature, scope, value }) => {
  console.log(`Feature "${feature}" resolved to ${value} for ${scope}`)
})
```

## Custom driver

Register a custom storage driver with `extend()`:

```typescript
import { flag } from '@strav/flag'
import type { FeatureStore } from '@strav/flag'

flag.extend('redis', (config) => {
  return new RedisFeatureStore(config)
})
```

The factory receives the driver's config object from `config/flag.ts`. The returned object must implement the `FeatureStore` interface.

Then set it as the driver in your config:

```typescript
export default {
  default: 'redis',
  drivers: {
    redis: {
      driver: 'redis',
      url: env('REDIS_URL', 'redis://localhost:6379'),
    },
  },
}
```

## CLI commands

The flag package provides three CLI commands (auto-discovered by the framework):

### flag:setup

Create the `_strav_features` table:

```bash
bun strav flag:setup
```

### flag:list

List all stored feature flags with their scopes and values:

```bash
bun strav flag:list
```

### flag:purge

Purge stored values for a specific feature or all features:

```bash
bun strav flag:purge beta-ui
bun strav flag:purge --all
```

## Testing

Use the `array` driver in tests to avoid hitting the database:

```env
# .env.test
FLAG_DRIVER=array
```

Call `FlagManager.reset()` in test teardown to clear definitions and stored values:

```typescript
import { beforeEach } from 'bun:test'
import FlagManager from '@strav/flag'

beforeEach(() => {
  FlagManager.reset()
})
```

## Controller example

```typescript
import { flag } from '@strav/flag'

export default class CheckoutController {
  async show(ctx: Context) {
    const user = ctx.get<User>('user')

    const variant = await flag.for(user).value('checkout-variant') as string

    return await flag.for(user).when(
      'new-checkout',
      () => ctx.json({ variant, layout: 'new' }),
      () => ctx.json({ layout: 'classic' }),
    )
  }

  async toggleBeta(ctx: Context) {
    const user = ctx.get<User>('user')
    const { enabled } = await ctx.body<{ enabled: boolean }>()

    if (enabled) {
      await flag.for(user).activate('beta-ui')
    } else {
      await flag.for(user).deactivate('beta-ui')
    }

    return ctx.json({ ok: true })
  }
}
```
