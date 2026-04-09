# Database

The database module provides the PostgreSQL connection wrapper, database introspection, and the full migration system.

## Database connection

The `Database` class wraps `Bun.sql` and reads connection settings from `config/database.ts`:

Using a service provider (recommended):

```typescript
import { DatabaseProvider } from '@strav/database'

app.use(new DatabaseProvider())
```

The `DatabaseProvider` registers `Database` as a singleton and closes the connection on shutdown. It depends on the `config` provider.

Or manually:

```typescript
import { Database } from '@strav/database'

app.singleton(Database)
const db = app.resolve(Database)
```

### Running queries

Import the `sql` tagged-template from `@strav/database` and use it directly:

```typescript
import { sql } from '@strav/database'

// Parameterized queries (safe by default)
const rows = await sql`SELECT * FROM "user" WHERE "role" = ${'admin'}`

// Dynamic queries (use with caution)
const rows = await sql.unsafe(
  'SELECT * FROM "user" WHERE "pid" = $1',
  [userId]
)
```

The `sql` export is a transparent proxy to the Database singleton's underlying Bun SQL connection. It's available after the Database is resolved through the DI container during bootstrap.

### Transactions

Never use raw `BEGIN`/`COMMIT` — Bun throws `ERR_POSTGRES_UNSAFE_TRANSACTION` with connection pooling.

#### `transaction()` helper (recommended)

The `transaction()` helper wraps a callback in a database transaction. It commits on success and rolls back on error:

```typescript
import { transaction } from '@strav/database'

await transaction(async (trx) => {
  await trx`INSERT INTO "order" ("user_id") VALUES (${userId})`
  await trx`UPDATE "inventory" SET "stock" = "stock" - 1 WHERE "product_id" = ${productId}`
})
```

The `trx` handle can be passed to ORM methods (`query()`, `create()`, `save()`, `delete()`, `forceDelete()`) so they run inside the same transaction — see the [ORM guide](./orm.md#transactions).

#### `sql.begin()` (low-level)

You can also use `sql.begin()` directly:

```typescript
import { sql } from '@strav/database'

await sql.begin(async (tx) => {
  await tx`INSERT INTO "order" ("user_id") VALUES (${userId})`
  await tx`UPDATE "inventory" SET "stock" = "stock" - 1 WHERE "product_id" = ${productId}`
})
```

### Closing the connection

```typescript
await db.close()
```

## Database introspection

The `DatabaseIntrospector` reads the live database schema and produces a `DatabaseRepresentation`:

```typescript
import { DatabaseIntrospector } from '@strav/database'

const introspector = new DatabaseIntrospector(db)
const actual = await introspector.introspect()

// actual.tables  — Map of table definitions
// actual.enums   — Map of enum definitions
```

The introspector automatically excludes the `_strav_migrations` tracking table.

## Migration system

### Overview

The migration pipeline works in three stages:

1. **Diff** — `SchemaDiffer` compares the desired state (from schemas) against the actual state (from introspection) and produces a list of changes.
2. **Generate SQL** — `SqlGenerator` converts the diff into executable SQL statements (both `up` and `down`).
3. **Write/Run** — `MigrationFileGenerator` writes the SQL to disk; `MigrationRunner` executes them.

### Migration file structure

Migrations are stored in `database/migrations/` as timestamped directories:

```
database/migrations/
  20250115_120000_create_users/
    manifest.json          # metadata: version, message, steps
    01_enums/
      up.sql               # CREATE TYPE ...
      down.sql             # DROP TYPE ...
    02_tables/
      user/
        up.sql             # CREATE TABLE ...
        down.sql           # DROP TABLE ...
    03_constraints/
      up.sql               # ALTER TABLE ADD CONSTRAINT ...
      down.sql             # ALTER TABLE DROP CONSTRAINT ...
    04_indexes/
      up.sql               # CREATE INDEX ...
      down.sql             # DROP INDEX ...
```

### Tracking

The `MigrationTracker` uses a `_strav_migrations` table to track which migrations have been applied. Migrations are grouped into **batches** — each `migrate` invocation creates a new batch.

### CLI commands

All migration operations are available through the CLI:

```bash
# Generate migration files from schema changes
bun strav generate:migration -m "add user roles"

# Apply pending migrations
bun strav migrate

# Roll back the last batch
bun strav rollback

# Roll back a specific batch
bun strav rollback --batch 3

# Compare schemas vs live database (read-only)
bun strav compare

# Drop everything and rebuild (local env only, requires confirmation)
bun strav fresh
```

### SchemaDiffer

Compares two `DatabaseRepresentation` objects and returns categorized changes:

```typescript
import { SchemaDiffer } from '@strav/database'

const differ = new SchemaDiffer()
const diff = differ.diff(desired, actual)

// diff.enums    — enum changes (create, drop, modify)
// diff.tables   — table changes (create, drop, modify with column-level detail)
// diff.indexes  — index changes
```

### SqlGenerator

Converts a diff into SQL:

```typescript
import { SqlGenerator } from '@strav/database'

const generator = new SqlGenerator()
const statements = generator.generate(diff)

// statements.up   — SQL to apply the migration
// statements.down — SQL to revert the migration
```

Important: serial columns (`serial`, `smallserial`, `bigserial`) are handled specially — no `NOT NULL` or `DEFAULT` is emitted for them, as PostgreSQL manages this automatically.

## Seeding

The `Seeder` base class provides a structured way to populate the database with dev/test data.

### Creating seeders

Generate a seeder with the CLI:

```bash
bun strav generate:seeder DatabaseSeeder
bun strav generate:seeder UserSeeder
```

This creates files in `database/seeders/`:

```typescript
import { Seeder } from '@strav/database'
import { UserFactory, PostFactory } from '../factories'

export default class DatabaseSeeder extends Seeder {
  async run(): Promise<void> {
    await this.call(UserSeeder)
    await this.call(PostSeeder)
  }
}
```

Sub-seeders focus on a single model or concern:

```typescript
import { Seeder } from '@strav/database'
import { UserFactory } from '../factories'

export default class UserSeeder extends Seeder {
  async run(): Promise<void> {
    await UserFactory.createMany(10)
    await UserFactory.create({ name: 'Admin', role: 'admin' })
  }
}
```

### Running seeders

```bash
# Run the default seeder (database/seeders/database_seeder.ts)
bun strav seed

# Run a specific seeder
bun strav seed --class UserSeeder

# Drop everything, re-migrate, then seed (APP_ENV=local only)
bun strav seed --fresh
```

### Factories

Seeders work with the `Factory` class from `@strav/testing`. Define factories in `database/factories/` so both seeders and tests can share them:

```
database/
  factories/
    user_factory.ts
    post_factory.ts
    index.ts
  seeders/
    database_seeder.ts
    user_seeder.ts
```

```typescript
// database/factories/user_factory.ts
import { Factory } from '@strav/testing'
import User from '../../app/models/user'

export const UserFactory = Factory.define(User, (seq) => ({
  pid: crypto.randomUUID(),
  name: `User ${seq}`,
  email: `user-${seq}@test.com`,
  passwordHash: 'hashed',
}))
```

See the [Testing guide](./testing.md#factory) for full factory API documentation.
