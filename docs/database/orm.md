# ORM

The ORM module provides an Active Record implementation with model decorators, relationship loading, and a fluent query builder.

## BaseModel

All models extend `BaseModel`. The framework generates model classes from your schemas, but the API is the same whether you write models by hand or generate them.

```typescript
import { BaseModel, primary } from '@strav/database'

class User extends BaseModel {
  static override softDeletes = true

  @primary
  declare pid: string

  declare username: string | null
  declare createdAt: DateTime
}
```

### Conventions

- **Table name**: derived from the class name — `User` becomes `user`, `OrderItem` becomes `order_item`.
- **Primary key**: marked with `@primary` (defaults to `id` if no decorator).
- **Column mapping**: camelCase properties map to snake_case columns automatically (`createdAt` <-> `created_at`).
- **Timestamps**: `Date` values from the database are hydrated as Luxon `DateTime` objects.

### The `declare` keyword

Properties that have no schema default use `declare` so they don't appear in `Object.keys()` on a fresh instance. This prevents them from being included in INSERT statements (letting the database generate values like serial PKs and timestamps).

Properties with schema defaults use initializers instead:

```typescript
role: UserRole = UserRole.User   // included in INSERT
declare createdAt: DateTime      // NOT included — DB generates it
```

## CRUD operations

### Creating records

```typescript
// Using create()
const user = await User.create({ username: 'alice' })

// Using save()
const user = new User()
user.username = 'alice'
await user.save()   // INSERT ... RETURNING *

// Using merge() + save()
const user = new User()
user.merge({ username: 'alice', role: 'admin' })
await user.save()

// Inside a transaction (all CRUD methods accept an optional trx parameter)
await transaction(async (trx) => {
  const user = await User.create({ username: 'alice' }, trx)
  await user.save(trx)
  await user.delete(trx)
})
```

`save()` on a new record runs an INSERT with `RETURNING *`, which populates all database-generated columns (PK, timestamps, etc.) back onto the instance.

### Reading records

```typescript
const user = await User.find(userId)            // returns null if not found
const user = await User.findOrFail(userId)      // throws if not found
const users = await User.all()                  // all non-deleted records
```

All static read methods respect soft deletes — soft-deleted records are excluded automatically.

### Merging data

`merge()` assigns properties from a plain object onto a model instance and returns `this` for chaining:

```typescript
const user = await User.findOrFail(userId)
user.merge({ username: 'bob', role: 'admin' }).save()
```

This is the recommended way to bulk-assign validated input to a model. Generated services use `merge()` internally.

### Updating records

```typescript
const user = await User.findOrFail(userId)
user.username = 'bob'
await user.save()   // UPDATE — auto-sets updatedAt
```

### Deleting records

```typescript
await user.delete()        // soft-delete if model supports it
await user.forceDelete()   // always hard-delete
```

## Decorators

### @primary

Marks the primary key property:

```typescript
@primary
declare id: number
```

If no property is decorated, the default PK name is `id`.

### @ulid

Marks a field as a ULID that should be auto-generated on insert if not provided:

```typescript
import { ulid } from '@strav/database'

@ulid
@primary
declare id: string  // Auto-generates ULID on insert
```

ULIDs (Universally Unique Lexicographically Sortable Identifiers) are 26-character strings that are:
- Lexicographically sortable (time-ordered)
- Cryptographically secure
- Compatible with distributed systems

The decorator works with fields defined as `t.ulid()` in schemas or any `char(26)` column.

### @reference (belongs-to)

Defines a belongs-to relationship. The decorated property is excluded from persistence and can be loaded on demand:

```typescript
@reference({ model: 'User', foreignKey: 'userId', targetPK: 'id' })
declare user: User
```

A bare `@reference` (without options) simply excludes the property from persistence.

### @associate (many-to-many)

Defines a many-to-many relationship through a pivot table:

```typescript
@associate({
  through: 'team_user',
  foreignKey: 'team_id',
  otherKey: 'user_pid',
  model: 'User',
  targetPK: 'pid',
})
declare members: User[]
```

### @cast (type casting)

Defines automatic type casting between database and application values. Transforms are applied during hydration (DB → model) and dehydration (model → DB).

```typescript
import { cast } from '@strav/database'

// Bare — defaults to JSON parsing/serialization
@cast
declare state: CanvasState

// Named built-in type
@cast('boolean')
declare isActive: boolean

// Custom get/set functions
@cast({ get: (v) => new Money(v as number), set: (v: Money) => v.toCents() })
declare price: Money
```

Built-in cast types: `'json'`, `'boolean'`, `'number'`, `'integer'`, `'string'`, `'bigint'`.

The JSON cast handles both `json` columns (stored as text, needs parsing) and `jsonb` columns (auto-parsed by Bun.sql, passed through as-is). Null values always pass through without casting.

The `'bigint'` cast converts BigInt values to `Number` when within the safe integer range, or to `String` for values exceeding `Number.MAX_SAFE_INTEGER`. Use it on `bigint`/`bigserial` columns to ensure JSON-safe values:

```typescript
@cast('bigint')
declare viewCount: number
```

### @encrypt (field-level encryption)

Encrypts a field before database storage (AES-256-GCM) and decrypts it on hydration. The database column **must** be TEXT to avoid truncating the encrypted payload.

```typescript
import { encrypt } from '@strav/database'

@encrypt
declare ssn: string
```

Encrypted fields are automatically excluded from `toJSON()` output to prevent leaking sensitive data into API responses or Vue island props. Access the decrypted value directly via the property.

### Serialization & BigInt safety

`toJSON()` automatically converts `DateTime` values to ISO 8601 strings and `BigInt` values to JSON-safe types (`Number` if within safe integer range, `String` otherwise). This prevents `JSON.stringify()` from throwing a `TypeError` on BigInt values.

> **Note:** Bun.sql returns `bigint`/`bigserial` columns as `number` for safe-range values and as `string` for large values by default, so BigInt primitives only appear if the connection is configured with `bigint: true` or values are set manually. The safety net is in place regardless.

Requires the `EncryptionProvider` to be booted (APP_KEY configured).

## Relationship loading

Use `load()` to eagerly load relationships:

```typescript
const profile = await Profile.findOrFail(1)
await profile.load('user', 'reviewer')   // loads @reference relations

const team = await Team.findOrFail(1)
await team.load('members')              // loads @associate relation

// Chaining
const user = await User.findOrFail(userId)
await user.load('teams')
console.log(user.teams)                 // Team[]
```

`load()` supports both `@reference` and `@associate` relationships and returns `this` for chaining.

## QueryBuilder

The `query()` function creates a fluent query builder for typed SELECT queries. It accepts an optional transaction handle as the second argument:

```typescript
import { query, transaction } from '@strav/database'
```

> **📖 Complete Reference**: For comprehensive QueryBuilder documentation including all methods, advanced patterns, and performance tips, see the [QueryBuilder Reference Guide](./query-builder.md).

### Basic queries

```typescript
const users = await query(User)
  .where('role', UserRole.Admin)
  .all()

const user = await query(User)
  .where('email', 'alice@example.com')
  .first()

const user = await query(User)
  .where('email', 'alice@example.com')
  .firstOrFail()  // throws if not found
```

### Where clauses

```typescript
query(User).where('age', '>=', 18)
query(User).whereIn('role', [UserRole.Admin, UserRole.Staff])
query(User).whereNotIn('status', ['banned'])
query(User).whereNull('deletedAt')
query(User).whereNotNull('username')
query(User).whereBetween('age', 18, 65)
query(User).whereRaw('"email" ILIKE $1', ['%@example.com'])
```

### Joins

```typescript
const results = await query(User)
  .innerJoin(Profile).on('User.pid', '=', 'Profile.userPid')
  .select('User.username', 'Profile.name')
  .all()
```

Join types: `leftJoin()`, `innerJoin()`, `rightJoin()`.

### Ordering, pagination, grouping

```typescript
query(User)
  .orderBy('createdAt', 'desc')
  .limit(20)
  .offset(40)
  .all()

query(User)
  .groupBy('role')
  .select('role', 'COUNT(*) AS count')
  .all()

query(User).distinct().all()
```

### Soft delete control

```typescript
query(User).withTrashed().all()    // include soft-deleted records
query(User).onlyTrashed().all()   // only soft-deleted records
```

### Aggregates and inspection

```typescript
const count = await query(User).where('role', 'admin').count()
const exists = await query(User).where('email', 'x@y.com').exists()

// Inspect generated SQL without executing
const { sql, params } = query(User).where('role', 'admin').toSQL()
```

### Pagination

The `paginate()` method returns a structured result with data and metadata:

```typescript
import { query, type PaginationResult } from '@strav/database'

const result: PaginationResult<User> = await query(User)
  .where('organizationId', orgId)
  .orderBy('createdAt', 'desc')
  .paginate(page, 20)

result.data       // User[]
result.meta.page      // current page (1-based)
result.meta.perPage   // items per page
result.meta.total     // total matching records
result.meta.lastPage  // last available page number
result.meta.from      // 1-based index of first item (0 when empty)
result.meta.to        // 1-based index of last item (0 when empty)
```

Signature: `paginate(page = 1, perPage = 15)`. The page number is clamped to a minimum of 1. Requesting a page beyond `lastPage` returns empty `data` with accurate `meta`.

Where clauses, joins, ordering, and soft-delete filters all apply normally — `paginate()` simply adds the correct `LIMIT` and `OFFSET` and runs a `COUNT(*)` query for the total.

### Column resolution

Column references are automatically resolved:

- `'email'` resolves to `"user"."email"` (primary table + snake_case).
- `'User.email'` resolves to `"user"."email"` (explicit model reference).
- `'Profile.userId'` resolves to `"profile"."user_id"` (cross-table with case conversion).

## Transactions

The `transaction()` helper runs a callback inside a database transaction that auto-commits on success and rolls back on error. Pass the `trx` handle to `query()`, `create()`, `save()`, `delete()`, and `forceDelete()` so they all run on the same connection:

```typescript
import { query, transaction } from '@strav/database'

const user = await transaction(async (trx) => {
  const u = await User.create({ name: 'Alice', email: 'alice@example.com' }, trx)
  await Profile.create({ userId: u.id, bio: 'Hello' }, trx)
  return u
})
```

QueryBuilder operations also accept the transaction handle:

```typescript
await transaction(async (trx) => {
  const user = await query(User, trx).where('email', 'alice@example.com').firstOrFail()
  user.role = 'admin'
  await user.save(trx)
  await query(AuditLog, trx).where('userId', user.id).delete()
})
```
