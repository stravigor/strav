# Error Handling & Exceptions

Typed error hierarchy, a global exception handler, and the `abort()` helper for clean HTTP error responses.

## Overview

Every framework error extends `StravError`, which extends `Error`. This lets you catch all framework errors with `instanceof StravError`, or target specific categories like `HttpException` or `ConfigurationError`.

The `ExceptionHandler` catches thrown errors and converts them into HTTP responses automatically — no more manual try/catch in every controller.

## Setup

In your bootstrap (`index.ts`):

```typescript
import { ExceptionHandler } from '@strav/kernel'

const handler = new ExceptionHandler(config.get('app.env') === 'local')
router.useExceptionHandler(handler)
```

Pass `true` for dev mode — stack traces are included in error responses. In production, unknown errors return a generic `"Internal Server Error"`.

## Throwing HTTP Errors

### With `abort()`

The quickest way to stop execution and return an HTTP error:

```typescript
import { abort } from '@strav/kernel'

// 404
const project = await Project.find(id)
if (!project) abort(404, 'Project not found')

// 403
if (!user.isAdmin) abort(403, 'Admin access required')

// 422 with structured validation errors
abort(422, { email: ['Required'], name: ['Too short'] })
```

### With error classes

For more control, throw an error class directly:

```typescript
import { NotFoundError, AuthorizationError, ValidationError } from '@strav/kernel'

throw new NotFoundError('Project not found')
throw new AuthorizationError('You do not own this resource')
throw new ValidationError({ email: ['Invalid format'] })
```

## HTTP Error Classes

| Class | Status | Default Message |
|-------|--------|-----------------|
| `BadRequestError` | 400 | Bad Request |
| `AuthenticationError` | 401 | Unauthenticated |
| `AuthorizationError` | 403 | Forbidden |
| `NotFoundError` | 404 | Not Found |
| `ConflictError` | 409 | Conflict |
| `ValidationError` | 422 | Validation Failed |
| `RateLimitError` | 429 | Too Many Requests |
| `ServerError` | 500 | Internal Server Error |

All extend `HttpException`, which extends `StravError`.

### HttpException

For non-standard status codes, use `HttpException` directly:

```typescript
import { HttpException } from '@strav/kernel'

throw new HttpException(402, 'Payment required')
throw new HttpException(418, "I'm a teapot")
```

### ValidationError

Carries structured field errors:

```typescript
const err = new ValidationError({
  email: ['Required', 'Must be valid'],
  password: ['Too short'],
})

err.status     // 422
err.errors     // { email: [...], password: [...] }
```

Rendered as:

```json
{
  "error": "Validation Failed",
  "errors": { "email": ["Required", "Must be valid"], "password": ["Too short"] }
}
```

### RateLimitError

Optionally carries a `Retry-After` value (seconds):

```typescript
throw new RateLimitError(60)  // Adds Retry-After: 60 header
throw new RateLimitError()    // No Retry-After header
```

## Module Errors

These are thrown internally by the framework. The ExceptionHandler maps them to appropriate HTTP responses.

| Class | HTTP Status | When |
|-------|-------------|------|
| `ConfigurationError` | 500 | Service not configured or unknown driver |
| `ModelNotFoundError` | 404 | `findOrFail()` / `firstOrFail()` with no result |
| `DatabaseError` | 500 | Migration or query failures |
| `EncryptionError` | 500 | Encrypt/decrypt/sign failures |
| `TemplateError` | 500 | View compilation or rendering errors |
| `ExternalServiceError` | 502 | AI provider, mail transport, or webhook errors |

### ModelNotFoundError

Thrown by `findOrFail()` and `firstOrFail()`:

```typescript
// These throw ModelNotFoundError automatically
const user = await User.findOrFail(id)
const post = await query(Post).where('slug', slug).firstOrFail()
```

The handler renders: `{ "error": "User with ID 42 not found" }` with status 404.

### ExternalServiceError

Thrown by AI providers, mail transports, and notification channels when external APIs return errors:

```typescript
import { ExternalServiceError } from '@strav/kernel'

throw new ExternalServiceError('Stripe', 402, 'Card declined')
// Message: "Stripe error (402): Card declined"
// Handler renders: { "error": "Service unavailable" } with status 502
```

## Custom Renderers

Override how specific error classes are rendered:

```typescript
import { ExceptionHandler } from '@strav/kernel'

class PaymentError extends StravError {
  constructor(public code: string, message: string) {
    super(message)
  }
}

const handler = new ExceptionHandler()

handler.render(PaymentError, (error) => {
  return Response.json(
    { error: error.message, code: error.code },
    { status: 402 }
  )
})
```

Custom renderers walk the prototype chain — a renderer for `HttpException` catches all its subclasses too (unless they have their own renderer).

## Reporters

Log or report errors before they're rendered:

```typescript
handler.report((error, ctx) => {
  logger.error(error.message, {
    path: ctx?.path,
    stack: error.stack,
  })
})

// Chain multiple reporters
handler
  .report((error) => logger.error(error.message))
  .report((error) => sentry.captureException(error))
```

Reporters never crash the handler — if a reporter throws, its error is silently swallowed.

## Error Hierarchy

```
Error
└── StravError
    ├── HttpException
    │   ├── BadRequestError (400)
    │   ├── AuthenticationError (401)
    │   ├── AuthorizationError (403)
    │   ├── NotFoundError (404)
    │   ├── ConflictError (409)
    │   ├── ValidationError (422)
    │   ├── RateLimitError (429)
    │   └── ServerError (500)
    ├── ConfigurationError
    ├── ModelNotFoundError
    ├── DatabaseError
    ├── EncryptionError
    ├── TemplateError
    └── ExternalServiceError
```

## Catching Errors

```typescript
import { StravError, HttpException, ConfigurationError } from '@strav/kernel'

try {
  await riskyOperation()
} catch (error) {
  if (error instanceof HttpException) {
    // Any HTTP error (400-599)
    console.log(error.status, error.message)
  } else if (error instanceof StravError) {
    // Any framework error
    console.log(error.name, error.message)
  }
}
```
