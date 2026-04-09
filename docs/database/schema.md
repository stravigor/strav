# Schema

The schema module lets you define your data models using a TypeScript DSL. Schemas are the single source of truth — they drive migrations, code generation, and database introspection.

## Defining a schema

```typescript
// database/schemas/user.ts
import { defineSchema, t, Archetype } from '@strav/database'

export default defineSchema('user', {
  archetype: Archetype.Entity,
  fields: {
    id: t.uuid().primaryKey(),
    username: t.string(),
    role: t.enum(['user', 'admin', 'staff', 'visitor']).default('user'),
  },
})
```

Every schema has:
- A **name** (snake_case, becomes the table name).
- An **archetype** that determines behavior (timestamps, soft deletes, etc.).
- A **fields** object using the type builder `t`.

## Archetypes

Strav defines 8 archetypes, each with specific timestamp rules:

| Archetype | Timestamps | Soft delete | Notes |
|-----------|-----------|-------------|-------|
| `entity` | created_at, updated_at | yes (deleted_at) | Top-level domain objects |
| `component` | created_at, updated_at | yes | Belongs to a parent entity |
| `attribute` | created_at, updated_at | yes | Dependent data on an entity |
| `association` | created_at | no | Pivot table between entities |
| `event` | created_at | no | Immutable event records |
| `reference` | created_at, updated_at | no | Lookup/reference data |
| `configuration` | created_at, updated_at | no | System configuration |
| `contribution` | created_at, updated_at | yes | User-contributed content |

Dependent archetypes (`component`, `attribute`, `event`, `configuration`, `contribution`) automatically receive foreign keys to their parents:

```typescript
import { defineSchema, t, Archetype } from '@strav/database'

export default defineSchema('profile', {
  archetype: Archetype.Attribute,
  parents: ['user'],           // adds user_pid FK automatically
  fields: {
    name: t.string(),
    reviewer: t.reference('user'),
  },
})
```

## Type builder

The `t` object provides fluent type definitions for all PostgreSQL types:

### Common types

```typescript
t.string()           // varchar(255)
t.text()             // text (unlimited)
t.integer()          // 4-byte integer
t.bigint()           // 8-byte integer
t.serial()           // auto-incrementing integer
t.boolean()          // true/false
t.uuid()             // UUID
t.ulid()             // ULID (stored as char(26))
t.timestamp()        // timestamp without timezone
t.timestamptz()      // timestamp with timezone
t.date()             // calendar date
t.json()             // JSON
t.jsonb()            // binary JSON
t.decimal(10, 2)     // exact numeric
```

### Modifiers

```typescript
t.string()
  .required()        // NOT NULL
  .unique()          // UNIQUE constraint
  .default('hello')  // DEFAULT value
  .index()           // create an index
  .primaryKey()      // mark as primary key
  .nullable()        // explicitly nullable (default)
```

### Validation modifiers

```typescript
t.string()
  .email()           // email format
  .url()             // URL format
  .min(3)            // minimum length/value
  .max(100)          // maximum length/value
  .regex(/^[a-z]+$/) // pattern match
  .length(10)        // exact length
```

### References

```typescript
t.reference('user')  // creates a foreign key to the user table
```

### Enums

```typescript
t.enum(['user', 'admin', 'staff'])  // PostgreSQL enum type
```

## Associations (many-to-many)

Define a pivot table between two entities using `defineAssociation`:

```typescript
// database/schemas/team_member.ts
import { defineAssociation, t } from '@strav/database'

export default defineAssociation(['team', 'user'], {
  as: { team: 'members', user: 'teams' },  // relationship names
  fields: {
    name: t.string(),         // extra pivot columns
    description: t.text(),
  },
})
```

This creates a `team_user` pivot table with foreign keys to both entities, plus any extra fields you define. The `as` option names the relationship on each side (used by the model generator for `@associate` decorators).

## ULIDs (Universally Unique Lexicographically Sortable Identifiers)

ULIDs are a sortable alternative to UUIDs. They contain a timestamp component and are lexicographically sortable:

```typescript
// In schema definition
export default defineSchema('user', {
  archetype: Archetype.Entity,
  fields: {
    id: t.ulid().primaryKey(),  // ULID as primary key
    email: t.varchar().email(),
  },
})
```

ULIDs are:
- 26 characters long (stored as `char(26)`)
- Lexicographically sortable (time-ordered)
- Cryptographically secure
- Auto-generated on insert if not provided

You can also generate ULIDs manually:

```typescript
import { ulid, isUlid } from '@strav/kernel'

const id = ulid()  // e.g., "01HQVB2YKQF5JZRJ8E9QKQHQWR"
console.log(isUlid(id))  // true
```

## Schema Registry

The `SchemaRegistry` discovers, validates, and resolves schemas:

```typescript
import { SchemaRegistry } from '@strav/database'

const registry = new SchemaRegistry()
await registry.discover('database/schemas')  // finds all schema files
registry.validate()                          // checks for errors

const schemas = registry.resolve()           // returns schemas in dependency order
const representation = registry.buildRepresentation()  // full DB representation
```

The registry handles dependency ordering — if `profile` depends on `user`, it ensures `user` is resolved first.
