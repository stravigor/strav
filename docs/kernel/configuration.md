# Configuration

The configuration module loads settings from the `config/` directory and provides dot-notation access to all values.

## Config files

Each file in `config/` exports a default object. The filename becomes the top-level key:

```typescript
// config/database.ts
import { env } from '@strav/kernel'

export default {
  host: env('DB_HOST', '127.0.0.1'),
  port: env.int('DB_PORT', 5432),
  username: env('DB_USER', 'postgres'),
  password: env('DB_PASSWORD', ''),
  database: env('DB_DATABASE', 'stravigor'),
}
```

```typescript
// config/http.ts
import { env } from '@strav/kernel'

export default {
  host: env('HTTP_HOST', '0.0.0.0'),
  port: env.int('HTTP_PORT', 3000),
  domain: env('APP_DOMAIN', 'localhost'),
}
```

## Loading configuration

### Using a service provider (recommended)

```typescript
import { ConfigProvider } from '@strav/kernel'

app.use(new ConfigProvider())
```

The `ConfigProvider` registers `Configuration` as a singleton and calls `load()` automatically. Pass `{ directory: './config' }` to customize the config path (default: `'./config'`).

### Manual setup

```typescript
import { Configuration } from '@strav/kernel'

const config = new Configuration('./config')
await config.load()
```

The `load()` method scans the directory and loads every supported file through the appropriate loader.

## Reading values

Use dot notation to access nested values:

```typescript
config.get('database.host')              // '127.0.0.1'
config.get('database.port')              // 5432
config.get('http.domain', 'localhost')   // with default fallback
```

Other access methods:

```typescript
config.has('database.host')   // true
config.set('app.debug', true) // set at runtime
config.all()                  // returns the entire config tree
```

## Supported file formats

| Format | Extensions | Loader |
|--------|-----------|--------|
| TypeScript | `.ts`, `.js` | `TypeScriptLoader` |
| Environment | `.env`, `.env.*` | `EnvLoader` |

The loader architecture is extensible — new formats (JSON, YAML, etc.) can be added by implementing the `ConfigurationLoader` interface.

## Environment-specific overrides

The `EnvLoader` supports environment-specific files. If you have `.env` and `.env.production`, the production values override the base values when loaded with the `production` environment name.

## Using with DI

The `Configuration` class is `@inject`-decorated, so it works with the container:

```typescript
app.singleton(Configuration)
// other services that depend on Configuration get it auto-injected
```
