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
