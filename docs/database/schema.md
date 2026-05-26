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

`ON DELETE` is derived from the field's nullability: `.required()` → `RESTRICT`, `.nullable()` → `SET NULL`. Tenanted-composite FKs (when the parent uses `t.tenantedSerial()` / `t.tenantedBigSerial()`) are auto-promoted to `(tenant_id, fk_id) → parent(tenant_id, id)` and use `CASCADE`, since the tenant column is `NOT NULL` and `SET NULL` is impossible on a composite.

#### Self-references

`t.reference()` accepts the schema's own name. The FK column is named after the field (e.g. `parentRevision: t.reference('revision').nullable()` → column `parent_revision_id`, FK to the same table's PK). Works on both regular and tenanted-composite schemas — useful for hierarchical structures like category trees and revision chains.

```typescript
defineSchema('category', {
  fields: {
    id: t.bigserial().primaryKey(),
    name: t.varchar(120).required(),
    parent: t.reference('category').nullable(),  // self-FK
  },
})
```

#### Cross-table cycles

Two schemas can reference each other freely (e.g. `workspace.owner → user`, `user.lastWorkspace → workspace`). The migration generator emits all `CREATE TABLE` statements first, then all FK constraints as `ALTER TABLE` in `constraints/up.sql` — the cycle is structural-only and resolves naturally. `down.sql` drops constraints first, then tables.

```typescript
defineSchema('workspace', {
  fields: {
    id: t.bigserial().primaryKey(),
    owner: t.reference('user').required(),
  },
})

defineSchema('user', {
  fields: {
    id: t.bigserial().primaryKey(),
    lastWorkspace: t.reference('workspace').nullable(),
  },
})
```

`SchemaRegistry.resolve()` (the topological sort over schemas) only considers `parents` and `associates` for ordering — `references` field deps are intentionally excluded so cycles like the one above don't surface as false-positive errors.

### Enums

```typescript
t.enum(['user', 'admin', 'staff'])  // PostgreSQL enum type
```

## Uniqueness

Three places to declare uniqueness, picked by what you're constraining.

### Single column on a hand-declared field

Use the field-level modifier:

```typescript
fields: {
  email: t.varchar(255).email().unique().required(),
}
```

Emits a unique index on the `email` column.

### Parent FK column (1:1 with parent)

`parents` accepts either bare names or `{ name, unique }` objects. Marking a parent `unique: true` constrains the auto-generated FK column so each parent row can have at most one child row. This is the canonical 1:1 component pattern.

```typescript
defineSchema('totp_secret', {
  archetype: Archetype.Component,
  parents: [{ name: 'user', unique: true }],
  fields: {
    secretEncrypted: t.bytea().required().sensitive(),
  },
})
```

Emits a unique index on `user_id`. For tenanted-composite parents (parent uses `t.tenantedSerial()`), uniqueness is automatically scoped to `(tenant_id, user_id)` so two tenants can each have their own row.

### Composite UNIQUE across multiple columns

Use schema-level `uniques`. Each entry is a list of logical names — a name resolves against (in order) `parents`, `fields`, then any column already on the table (so you can reference `tenant_id` or `created_at` explicitly).

```typescript
defineSchema('oauth_identity', {
  archetype: Archetype.Component,
  parents: ['user'],
  fields: {
    provider: t.enum(['google', 'github']).required(),
    providerUserId: t.varchar(255).required(),
  },
  uniques: [
    ['provider', 'providerUserId'],   // → UNIQUE(provider, provider_user_id)
  ],
})
```

```typescript
defineSchema('recovery_code', {
  archetype: Archetype.Component,
  parents: ['user'],
  fields: { codeHash: t.varchar(255).required() },
  uniques: [
    ['user', 'codeHash'],             // parent shorthand → UNIQUE(user_id, code_hash)
  ],
})
```

Single-column entries become a unique index; multi-column entries become a UNIQUE constraint plus its backing index. Naming is automatic (`uq_<table>_<col>_<col>`, `idx_<table>_<col>_<col>_unique`); rename by hand-editing the migration if you need a custom identifier.

The DSL throws at `defineSchema` time on duplicate parent names, empty entries, or duplicate columns inside an entry, and at representation-build time if a name doesn't resolve to a known parent / field / column.

## PostgreSQL extensions

Schemas declare the Postgres extensions they need; the migration generator collects them, dedupes, and emits `CREATE EXTENSION IF NOT EXISTS` ahead of any `CREATE TABLE` so column types like `vector(1536)` resolve.

```typescript
import { defineSchema, t, Archetype } from '@strav/database'

export default defineSchema('embedding', {
  archetype: Archetype.Component,
  parents: ['doc'],
  extensions: ['vector'],
  fields: {
    contentHash: t.varchar(64).required(),
    paragraphIdx: t.integer().required(),
  },
})
```

The next `bun strav generate:migration` writes `extensions/up.sql` to the migration directory and runs it before any other DDL:

```sql
-- extensions/up.sql
CREATE EXTENSION IF NOT EXISTS "vector";
```

`extensions/down.sql` mirrors with `DROP EXTENSION IF EXISTS` and runs *last* in the down direction (after dependent tables are gone). The `IF NOT EXISTS` / `IF EXISTS` clauses make both directions idempotent.

**Diff semantics.** Extensions are diffed against the live database via `pg_extension`:

- Adding an extension to any schema → next migration emits only the new `CREATE EXTENSION`.
- Removing the last reference to an extension → next migration emits the matching `DROP EXTENSION`.
- An extension already declared *and* installed → no change emitted.
- `plpgsql` (always present in Postgres) is excluded from introspection so it never shows up as a phantom drop.

**Naming.** Names are quoted in the emitted SQL, so hyphens are safe (`'uuid-ossp'`, `'pg_stat_statements'`). The DSL accepts any string — the framework doesn't whitelist names so you can use any extension your Postgres instance has available.

**Multiple schemas, same extension.** Declare freely; `RepresentationBuilder` dedupes across the registry and the migration includes one `CREATE EXTENSION` per name.

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

### Discovering schemas at app boot

The CLI bootstrap discovers schemas automatically for migration and generator commands. **At app boot** (anything that goes through `app.useProviders([...])`), add `SchemaProvider` so the same discovery runs before any other provider that needs schema metadata:

```typescript
// start/providers.ts
import { ConfigProvider } from '@strav/kernel'
import { SchemaProvider, DatabaseProvider } from '@strav/database'

export default [
  new ConfigProvider(),
  new SchemaProvider(),     // discovers + validates ./database/schemas
  new DatabaseProvider(),
]
```

`SchemaProvider` registers `SchemaRegistry` as a singleton, runs `discover()` + `validate()` during boot, and is required before `DatabaseProvider` in any multi-tenant app — without it, the `tenantRegistry: true` schema's name and PK type never reach the runtime and tenant RLS DDL silently falls back to defaults. See [Multi-tenant — Wiring at app boot](./multitenant.md#wiring-at-app-boot).

The discovery path resolves in this order:

1. Constructor option — `new SchemaProvider({ path: 'src/db/schemas' })`.
2. `database.schemasPath` config key.
3. `'./database/schemas'` (framework default).

If you've customised the path in `config/generators.ts`, set `database.schemasPath` to the same value so the runtime and CLI agree on where schemas live.
