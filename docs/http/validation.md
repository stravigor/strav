# Validation

The validation module provides composable rule factories and a `validate()` function for checking input data against declarative rule sets.

## Quick start

```typescript
import { validate, required, string, integer, min, max, email } from '@strav/http'

const { data, errors } = validate(input, {
  name:  [required(), string(), min(3), max(100)],
  email: [required(), email()],
  age:   [integer(), min(18)],
})

if (errors) {
  return ctx.json({ errors }, 422)
}

// data is typed and contains only declared fields
```

## Rules

Every rule is a factory function returning a `Rule` object:

```typescript
interface Rule {
  name: string
  validate(value: unknown): string | null  // error message or null
  coerce?(value: unknown): unknown          // optional pre-validation transform
}
```

All rules pass on `null`/`undefined` — use `required()` to enforce presence.

### Available rules

| Rule | Description | Error message |
|------|-------------|---------------|
| `required()` | Value must not be null, undefined, or empty string | `This field is required` |
| `string()` | Must be a string | `Must be a string` |
| `integer()` | Must be an integer (coerces numeric strings) | `Must be an integer` |
| `number()` | Must be a number, not NaN (coerces numeric strings) | `Must be a number` |
| `boolean()` | Must be a boolean (coerces `"true"/"1"/"on"` and `"false"/"0"/"off"`) | `Must be a boolean` |
| `min(n)` | Numbers: `>= n`. Strings: length `>= n` | `Must be at least {n}` / `Must be at least {n} characters` |
| `max(n)` | Numbers: `<= n`. Strings: length `<= n` | `Must be at most {n}` / `Must be at most {n} characters` |
| `email()` | Must be a valid email address | `Must be a valid email address` |
| `url()` | Must be a valid URL | `Must be a valid URL` |
| `regex(pattern)` | Must match a RegExp pattern | `Must match pattern {pattern}` |
| `enumOf(enum)` | Must be a value of the given TypeScript enum | `Must be one of: {values}` |
| `oneOf(values)` | Must be one of the given values | `Must be one of: {values}` |
| `array()` | Must be an array | `Must be an array` |

### Examples

```typescript
import { required, string, min, max, email, enumOf, oneOf, regex } from '@strav/http'
import { UserRole } from '../enums/user'

// Username: required string between 3 and 30 characters
const usernameRules = [required(), string(), min(3), max(30)]

// Role: must be a valid UserRole enum value
const roleRules = [required(), enumOf(UserRole)]

// Status: must be one of specific string values (no enum)
const statusRules = [required(), oneOf(['active', 'inactive', 'suspended'])]

// Phone: optional, but must match a pattern if provided
const phoneRules = [string(), regex(/^\+\d{10,15}$/)]
```

## Coercion

HTML form bodies always arrive as strings (`<input type="number">` posts `"5"`, not `5`). The type-shape rules — `integer()`, `number()`, `boolean()` — coerce strings to their native types before validating, so the same rule set works for both JSON and form bodies without per-handler boilerplate. The coerced value is what ends up in `data` and what subsequent rules in the chain see.

```typescript
const { data, errors } = validate<{ position: number; done: boolean }>(
  { position: '5', done: 'on' },          // form body — strings
  {
    position: [required(), integer(), min(0)],
    done:     [boolean()],
  }
)

data.position  // 5         (number)
data.done      // true      (boolean)
```

**Coercion rules:**

- `integer()` / `number()` parse with `Number(value)`. `"5"` → `5`, `"5.5"` → `5.5`. Strings that can't parse (`"abc"`) are left as-is so `validate()` rejects them. Empty strings are passed through so `required()` keeps owning emptiness.
- `boolean()` accepts `"true"`, `"1"`, `"on"` (true) and `"false"`, `"0"`, `"off"` (false), case-insensitive. Anything else is left as-is and rejected.
- Coercions run in declared rule order before any validation, so chaining (`integer(), min(10)`) works as expected — `min(10)` sees the coerced number.

## validate()

```typescript
function validate<T>(input: unknown, rules: RuleSet): ValidationResult<T>
```

- Synchronous — no async overhead.
- Runs rules per field, stopping at the first error for each field.
- Strips unknown fields from `data` — only declared fields are returned.
- Omits `undefined` values — fields not present in the input are excluded from `data`, making partial updates safe (only submitted fields are included).
- Applies any rule's `coerce()` before validation; the coerced value is what lands in `data`.
- Returns `errors: null` when all rules pass.

### Return type

```typescript
interface ValidationResult<T = Record<string, unknown>> {
  data: T                                   // only declared fields
  errors: Record<string, string[]> | null   // null when valid
}
```

### Typed results

Use a generic to get typed `data`:

```typescript
interface CreateUserInput {
  name: string
  email: string
  role: string
}

const { data, errors } = validate<CreateUserInput>(body, {
  name:  [required(), string()],
  email: [required(), email()],
  role:  [required(), oneOf(['admin', 'user'])],
})

if (!errors) {
  data.name  // typed as string
  data.email // typed as string
}
```

## Usage in controllers

The typical pattern in a controller action:

```typescript
async store(ctx: Context) {
  const body = await ctx.body()
  const { data, errors } = validate(body, UserRules.store)
  if (errors) return ctx.json({ errors }, 422)

  const user = await service.create(data)
  return ctx.json(user, 201)
}
```

## Generated validators

Running `bun strav generate:api` auto-generates validators from schema field definitions. Each validator has `store` (with `required()` on required fields) and `update` (without `required()`) rule sets:

```typescript
// app/validators/user_validator.ts — Generated by Strav
import { enumOf, string } from '@strav/http'
import { UserRole } from '../enums/user'

export const UserRules: Record<string, RuleSet> = {
  store: {
    username: [required(), string()],
    role: [enumOf(UserRole)],
  },
  update: {
    username: [string()],
    role: [enumOf(UserRole)],
  },
}
```

Enum fields use `enumOf(Enum)` referencing the generated TypeScript enum, so validators stay in sync when enum values change. Fields with inline `enumValues` (no custom type) still use `oneOf([...])`.

System-managed fields (id, timestamps, parent FK) are excluded from generated validators. Reference FK fields (e.g., `authorPid` from `t.reference('user')`) are included using their FK column name and validated with the referenced PK's type.

## Writing custom rules

A rule is just an object with `name` and `validate`:

```typescript
import type { Rule } from '@strav/http'

function slug(): Rule {
  return {
    name: 'slug',
    validate(value) {
      if (value === undefined || value === null) return null
      if (typeof value !== 'string') return 'Must be a string'
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) return 'Must be a valid slug'
      return null
    },
  }
}
```

Follow the convention: return `null` for undefined/null (let `required()` handle presence), return an error string on failure.

If your rule needs to transform the input (parse a date string, normalize whitespace, etc.), add an optional `coerce()`. The coerced value is what `validate()` checks and what ends up in the result `data`:

```typescript
function date(): Rule {
  return {
    name: 'date',
    coerce(value) {
      if (typeof value !== 'string' || value.trim() === '') return value
      const d = new Date(value)
      return Number.isNaN(d.getTime()) ? value : d
    },
    validate(value) {
      if (value === undefined || value === null || value === '') return null
      if (!(value instanceof Date)) return 'Must be a valid date'
      return null
    },
  }
}
```
