# Helpers

Utility functions used throughout the framework and available to application code.

## env() — Environment variables

Read environment variables with type safety. Bun automatically loads `.env` files, so all variables are available without any setup.

```typescript
import { env } from '@strav/kernel'
```

### String values

```typescript
env('APP_NAME')                // returns string, throws if not set
env('APP_NAME', 'stravigor')   // returns string, falls back to default
```

### Nullable default

Use `null` to get `string | null` instead of throwing when the variable is unset:

```typescript
env('S3_ENDPOINT', null)   // string | null — returns null if unset
```

### Typed values

```typescript
env.int('DB_PORT', 5432)       // parsed as integer
env.float('TAX_RATE', 0.2)    // parsed as float
env.bool('APP_DEBUG', false)   // true for 'true', '1', 'yes'
```

All typed accessors throw if the variable is not set and no default is provided. If the variable exists but cannot be parsed (e.g., `env.int('NOT_A_NUMBER')`), the default is returned.

## config() — Configuration access

Access configuration values without manually resolving from the container. The helper lazily resolves and caches the Configuration instance.

```typescript
import { config } from '@strav/kernel'
```

### Basic usage

```typescript
config('database.host')                  // returns value, uses Configuration.get()
config('database.port', 5432)            // with default fallback
config('app.name', 'My App')             // 'My App' if not set
```

### Typed values

```typescript
config.int('app.port', 3000)            // parsed as integer
config.float('cache.ratio', 0.75)       // parsed as float
config.bool('app.debug', false)         // boolean conversion
config.array('app.tags', [])            // ensures array type
```

### Additional methods

```typescript
config.has('database.host')             // check if key exists
config.set('app.debug', true)           // set value at runtime
config.all()                            // get entire config tree
```

The config helper provides the same simple access pattern as `env()` but for configuration values loaded from the `config/` directory. It requires the ConfigProvider to be registered with the app.

## String helpers

Case conversion functions for transforming between naming conventions.

```typescript
import { toSnakeCase, toCamelCase, toPascalCase } from '@strav/kernel'
```

### toSnakeCase

Converts camelCase or PascalCase to snake_case:

```typescript
toSnakeCase('firstName')    // 'first_name'
toSnakeCase('OrderItem')    // 'order_item'
toSnakeCase('HTMLParser')   // 'html_parser'
toSnakeCase('already_snake') // 'already_snake' (no-op)
```

### toCamelCase

Converts snake_case to camelCase:

```typescript
toCamelCase('first_name')      // 'firstName'
toCamelCase('created_at')      // 'createdAt'
toCamelCase('order_event_type') // 'orderEventType'
```

### toPascalCase

Converts snake_case to PascalCase:

```typescript
toPascalCase('user_role')   // 'UserRole'
toPascalCase('order_item')  // 'OrderItem'
toPascalCase('user')        // 'User'
```

### pluralize

Naively pluralize an English word. Handles common suffixes:

```typescript
import { pluralize } from '@strav/kernel'

pluralize('user')      // 'users'
pluralize('category')  // 'categories'
pluralize('status')    // 'statuses'
pluralize('match')     // 'matches'
```

Used internally by the route generator to build URL paths from schema names.

These helpers are used internally by the ORM (table names, column mapping) and the code generators.

## Crypto

```typescript
import { randomHex } from '@strav/kernel'
```

### randomHex

Generate a cryptographically random hex string of the given byte length:

```typescript
randomHex(16)   // 32-char hex string (16 bytes)
randomHex(32)   // 64-char hex string (32 bytes)
```

Used internally for CSRF tokens and session IDs.

## redact() — secret redaction

Scrub secrets from any payload before it lands in a log, audit row, devtools capture, or error wrapper. Returns a deep copy of the input with values for sensitive keys replaced by `[REDACTED]`.

```typescript
import { redact, defaultRedactKeys } from '@strav/kernel'
```

### Basic usage

```typescript
redact({ authorization: 'Bearer abc', accept: 'application/json' })
// → { authorization: '[REDACTED]', accept: 'application/json' }

redact({
  user: { id: 1, password: 'p4ss', name: 'Alice' },
  tokens: [{ access_token: 't1' }, { access_token: 't2' }],
})
// → {
//     user: { id: 1, password: '[REDACTED]', name: 'Alice' },
//     tokens: [{ access_token: '[REDACTED]' }, { access_token: '[REDACTED]' }],
//   }
```

Matching is **case-insensitive and exact** (not substring). The default deny-list covers:

- HTTP auth headers: `authorization`, `cookie`, `set-cookie`, `x-api-key`, `x-auth-token`, `x-csrf-token`, `csrf-token`, `proxy-authorization`
- Common secret fields: `password`, `passwd`, `pwd`, `token`, `access_token`, `refresh_token`, `id_token`, `secret`, `client_secret`, `api_key`, `apikey`
- Session identifiers: `session`, `session_id`, `sessionid`
- Common camelCase variants of the above (`accessToken`, `refreshToken`, `clientSecret`, `csrftoken`, etc.)

The full list is exported as `defaultRedactKeys` for inspection.

### Options

```typescript
interface RedactOptions {
  extraKeys?: readonly string[]   // Add to the default list (case-insensitive)
  keys?: readonly string[]        // Replace the default list entirely
  replacement?: string            // Default '[REDACTED]'
}
```

```typescript
// Extend the default deny-list with app-specific names
redact(payload, { extraKeys: ['internalCode', 'x-tenant-id'] })

// Replace the deny-list entirely (e.g., for a domain-specific scrubber)
redact(payload, { keys: ['ssn', 'dob'] })

// Custom replacement string
redact(payload, { replacement: '***' })
```

### Behavior

- **Walks** plain objects and arrays.
- **Skips** (passes through unchanged): `Date`, `Buffer`, typed arrays, `null`, `undefined`, primitives, class instances. Class instances are not traversed — properties of `User`, `Headers`, etc. are not redacted, so flatten to a plain object first if you need recursion.
- **Does not mutate** the input. The returned object is a new structure.
- **Replaces only string-shaped values** at deny-listed keys. A null or undefined value at a deny-listed key passes through unchanged.

### Where it's used

- `@strav/devtools` `RequestCollector` (request and response headers) and `LogCollector` (structured `context` payloads).
- Application code: anywhere a payload originating from user input or external systems will be persisted to an observability surface.

```typescript
import { Logger } from '@strav/kernel'
import { redact } from '@strav/kernel'

Logger.warn('payment failed', redact(rawWebhookPayload))
```

## scrubProviderError() — error-text credential scrubber

Sister of `redact()` for the case where the input is *free-form text* rather than a structured object — typically the response body of an upstream-provider HTTP failure that's about to be wrapped in `ExternalServiceError`. Used by `@strav/brain`, `@strav/signal`, and `@strav/social` provider error paths.

```typescript
import { scrubProviderError, ExternalServiceError } from '@strav/kernel'

if (!response.ok) {
  const text = await response.text()
  throw new ExternalServiceError(this.name, response.status, scrubProviderError(text))
}
```

The scrubber:

1. **JSON path:** if the text parses as JSON, run it through `redact()` and re-stringify so structured fields named `password` / `token` / `secret` / `api_key` / `authorization` become `[REDACTED]`.
2. **Regex fallback** for plain text: replace Bearer tokens, `sk-` / `sk_` prefixed keys, header-style `x-api-key: value` embeds, and `?api_key=…` query-string credentials with the same `[REDACTED]` marker.

Empty / null / undefined inputs return `''`. The scrubber is deterministic and idempotent — applying it twice is safe.

## Identity

```typescript
import { extractUserId } from '@strav/database'
```

### extractUserId

Extract a user ID from a BaseModel instance or a raw string/number:

```typescript
extractUserId(user)       // reads the primary key from a BaseModel instance
extractUserId('abc-123')  // returns 'abc-123'
extractUserId(42)         // returns '42'
```

Throws if the value is not a BaseModel, string, or number. Used internally by the session and auth modules.
