# Schema-Driven Development with Spring

Spring applications embrace **schema-driven development**, where your database schema definitions serve as the single source of truth for your entire application. This approach eliminates the common mismatch between code and database, ensuring consistency and enabling powerful code generation.

## Philosophy

In traditional development, you often write:
1. Database migrations
2. Model classes
3. TypeScript interfaces
4. API validation schemas
5. Frontend type definitions

With Strav's schema-driven approach, you define your schema **once** and everything else is generated:

```typescript
// database/schemas/user.ts - Single source of truth
import { defineSchema, t, Archetype } from '@strav/database'

export default defineSchema('user', {
  archetype: Archetype.Entity,
  fields: {
    id: t.uuid().primaryKey(),
    email: t.string().email().unique().required(),
    name: t.string().required(),
    role: t.enum(['admin', 'user', 'guest']).default('user'),
  },
})
```

From this single definition, Strav generates:
- ✅ PostgreSQL migrations
- ✅ TypeScript model classes
- ✅ API validation schemas
- ✅ Type-safe query builders
- ✅ Factory patterns for testing

## Schema Archetypes

Strav defines 8 archetypes that capture common database patterns:

### 1. Entity (`Archetype.Entity`)

Top-level business objects that exist independently.

```typescript
// database/schemas/user.ts
export default defineSchema('user', {
  archetype: Archetype.Entity,
  fields: {
    id: t.uuid().primaryKey(),
    email: t.string().email().unique().required(),
    name: t.string().required(),
    avatar_url: t.string().url().nullable(),
    email_verified_at: t.timestamp().nullable(),
  },
})

// database/schemas/post.ts
export default defineSchema('post', {
  archetype: Archetype.Entity,
  fields: {
    id: t.uuid().primaryKey(),
    title: t.string().required(),
    slug: t.string().unique().required(),
    content: t.text().required(),
    status: t.enum(['draft', 'published', 'archived']).default('draft'),
    author_id: t.reference('user'),
    published_at: t.timestamp().nullable(),
  },
})
```

**Generated features:**
- `created_at`, `updated_at` timestamps
- Soft deletes with `deleted_at`
- Full CRUD operations
- Relationships to other entities

### 2. Component (`Archetype.Component`)

Parts of an entity that don't exist independently.

```typescript
// database/schemas/address.ts
export default defineSchema('address', {
  archetype: Archetype.Component,
  parents: ['user'], // Automatically adds user_id foreign key
  fields: {
    type: t.enum(['home', 'work', 'billing', 'shipping']).required(),
    street_address: t.string().required(),
    city: t.string().required(),
    state: t.string(2).required(),
    postal_code: t.string(10).required(),
    country: t.string(2).default('US'),
  },
})
```

**Generated features:**
- Automatic foreign keys to parent entities
- Soft deletes (cascades with parent)
- Always loaded in context of parent

### 3. Attribute (`Archetype.Attribute`)

Configuration or metadata attached to entities.

```typescript
// database/schemas/user_preferences.ts
export default defineSchema('user_preferences', {
  archetype: Archetype.Attribute,
  parents: ['user'],
  fields: {
    theme: t.enum(['light', 'dark', 'auto']).default('auto'),
    language: t.string(5).default('en'),
    timezone: t.string().default('UTC'),
    email_notifications: t.boolean().default(true),
    marketing_emails: t.boolean().default(false),
  },
})
```

**Generated features:**
- One-to-one relationship with parent
- Usually loaded eagerly with parent
- Soft deletes with parent

### 4. Association (`Archetype.Association`)

Many-to-many relationships between entities.

```typescript
// database/schemas/user_role.ts - Pivot table
export default defineAssociation(['user', 'role'], {
  as: { user: 'roles', role: 'users' }, // Relationship names
  fields: {
    granted_at: t.timestamp().default('NOW()'),
    granted_by: t.reference('user').nullable(),
    expires_at: t.timestamp().nullable(),
  },
})
```

**Generated features:**
- Foreign keys to both entities
- Optional pivot data
- `created_at` timestamp only
- Named relationships on models

### 5. Event (`Archetype.Event`)

Immutable audit logs and event records.

```typescript
// database/schemas/audit_log.ts
export default defineSchema('audit_log', {
  archetype: Archetype.Event,
  fields: {
    entity_type: t.string().required(), // 'user', 'post', etc.
    entity_id: t.uuid().required(),
    action: t.enum(['created', 'updated', 'deleted']).required(),
    changes: t.jsonb().nullable(),
    user_id: t.reference('user').nullable(),
    ip_address: t.string().nullable(),
    user_agent: t.text().nullable(),
  },
})
```

**Generated features:**
- `created_at` timestamp only (immutable)
- No updates or deletes (append-only)
- Optimized for high-volume inserts

### 6. Reference (`Archetype.Reference`)

Lookup tables and reference data.

```typescript
// database/schemas/country.ts
export default defineSchema('country', {
  archetype: Archetype.Reference,
  fields: {
    code: t.string(2).primaryKey(), // ISO country code
    name: t.string().required(),
    continent: t.string().required(),
    currency_code: t.string(3).required(),
    phone_prefix: t.string(10).required(),
  },
})

// database/schemas/category.ts
export default defineSchema('category', {
  archetype: Archetype.Reference,
  fields: {
    id: t.uuid().primaryKey(),
    name: t.string().unique().required(),
    slug: t.string().unique().required(),
    description: t.text().nullable(),
    parent_id: t.reference('category').nullable(), // Self-referencing
  },
})
```

**Generated features:**
- Often cached in memory
- Rarely updated after initialization
- Used in dropdowns and lookups

### 7. Configuration (`Archetype.Configuration`)

System and application settings.

```typescript
// database/schemas/app_setting.ts
export default defineSchema('app_setting', {
  archetype: Archetype.Configuration,
  fields: {
    key: t.string().primaryKey(),
    value: t.jsonb().required(),
    description: t.text().nullable(),
    is_public: t.boolean().default(false), // Can be exposed to frontend
    last_updated_by: t.reference('user').nullable(),
  },
})
```

**Generated features:**
- Key-value store pattern
- Often cached globally
- Admin-only updates

### 8. Contribution (`Archetype.Contribution`)

User-generated content and community features.

```typescript
// database/schemas/comment.ts
export default defineSchema('comment', {
  archetype: Archetype.Contribution,
  parents: ['post'], // Comments belong to posts
  fields: {
    content: t.text().required(),
    author_id: t.reference('user'),
    parent_id: t.reference('comment').nullable(), // Nested comments
    is_approved: t.boolean().default(false),
    flagged_at: t.timestamp().nullable(),
  },
})
```

**Generated features:**
- Moderation capabilities
- Soft deletes with approval workflow
- User attribution tracking

## Schema Definition API

### Field Types

Strav provides a comprehensive type builder:

```typescript
// Common types
t.string()              // VARCHAR(255)
t.string(100)          // VARCHAR(100)
t.text()               // TEXT (unlimited)
t.integer()            // 4-byte integer
t.bigint()             // 8-byte integer
t.decimal(10, 2)       // DECIMAL(10,2)
t.boolean()            // Boolean
t.uuid()               // UUID
t.ulid()               // ULID (char(26), sortable)
t.timestamp()          // TIMESTAMP
t.timestamptz()        // TIMESTAMP WITH TIMEZONE
t.date()               // DATE only
t.json()               // JSON
t.jsonb()              // JSONB (binary JSON)

// PostgreSQL-specific
t.array('string')      // String array
t.point()              // Geometric point
t.cidr()               // Network address
```

### Constraints and Validation

```typescript
t.string()
  .required()           // NOT NULL
  .unique()            // UNIQUE constraint
  .default('hello')    // DEFAULT value
  .index()             // Create index
  .primaryKey()        // Primary key

// Validation (enforced at application level)
t.string()
  .email()             // Email format
  .url()               // URL format
  .min(3)              // Minimum length
  .max(100)            // Maximum length
  .regex(/^[a-z]+$/)   // Pattern match
  .length(10)          // Exact length

t.integer()
  .min(0)              // Minimum value
  .max(1000)           // Maximum value
  .positive()          // > 0
  .negative()          // < 0

t.decimal(8, 2)
  .min(0.01)           // Minimum monetary value
  .max(999999.99)      // Maximum monetary value
```

### References and Relationships

```typescript
// Foreign keys
t.reference('user')                    // user_id UUID reference
t.reference('user', 'email')          // References user.email instead of id
t.reference('category').nullable()     // Optional reference

// Self-referencing
t.reference('comment').nullable()      // parent_comment_id

// Polymorphic references (advanced)
t.morphs('commentable')               // commentable_id + commentable_type
```

### Enums

```typescript
// Simple enum
t.enum(['draft', 'published', 'archived'])

// With default
t.enum(['admin', 'user', 'guest']).default('user')

// Named enum (reusable)
const UserStatus = t.enum(['active', 'suspended', 'deleted'])
export { UserStatus }

// Use in multiple schemas
export default defineSchema('user', {
  fields: {
    status: UserStatus.default('active'),
  }
})
```

## Development Workflow

### 1. Schema-First Development

Always start with the schema:

```bash
# Create new schema
bun strav make:schema order --archetype=entity

# Define the schema fields
# database/schemas/order.ts
```

```typescript
export default defineSchema('order', {
  archetype: Archetype.Entity,
  fields: {
    id: t.uuid().primaryKey(),
    customer_id: t.reference('user'),
    total_amount: t.decimal(10, 2).min(0.01).required(),
    status: t.enum(['pending', 'confirmed', 'shipped', 'delivered', 'cancelled']).default('pending'),
    shipping_address: t.jsonb().required(),
    billing_address: t.jsonb().required(),
    notes: t.text().nullable(),
    shipped_at: t.timestamp().nullable(),
    delivered_at: t.timestamp().nullable(),
  },
})
```

### 2. Generate and Review Migration

```bash
# Generate migration from schema
bun strav generate:migration --message="add order schema"
```

Review the generated migration:

```sql
-- database/migrations/20240410_100000_add_order_schema/01_tables/order/up.sql
CREATE TABLE "order" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "customer_id" UUID NOT NULL REFERENCES "user"("id"),
  "total_amount" DECIMAL(10,2) NOT NULL CHECK ("total_amount" >= 0.01),
  "status" order_status_enum NOT NULL DEFAULT 'pending',
  "shipping_address" JSONB NOT NULL,
  "billing_address" JSONB NOT NULL,
  "notes" TEXT,
  "shipped_at" TIMESTAMP,
  "delivered_at" TIMESTAMP,
  "created_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMP NOT NULL DEFAULT NOW(),
  "deleted_at" TIMESTAMP
);

CREATE INDEX "order_customer_id_idx" ON "order"("customer_id");
CREATE INDEX "order_status_idx" ON "order"("status");
```

### 3. Run Migration

```bash
bun strav migrate
```

### 4. Generate Model (Optional)

Models can be auto-generated or hand-crafted:

```bash
bun strav generate:models
```

```typescript
// app/models/order.ts (generated)
import { Model, column, belongsTo, hasMany } from '@strav/database'
import User from './user.ts'
import OrderItem from './order_item.ts'

export default class Order extends Model {
  @column({ isPrimary: true })
  declare id: string

  @column()
  declare customer_id: string

  @column()
  declare total_amount: number

  @column()
  declare status: 'pending' | 'confirmed' | 'shipped' | 'delivered' | 'cancelled'

  @column()
  declare shipping_address: Record<string, any>

  @column()
  declare billing_address: Record<string, any>

  @column()
  declare notes: string | null

  @column()
  declare shipped_at: Date | null

  @column()
  declare delivered_at: Date | null

  @column()
  declare created_at: Date

  @column()
  declare updated_at: Date

  @column()
  declare deleted_at: Date | null

  // Relationships
  @belongsTo(() => User, 'customer_id')
  declare customer: User

  @hasMany(() => OrderItem, 'order_id')
  declare items: OrderItem[]
}
```

### 5. Create Supporting Code

```bash
# Generate controller
bun strav make:controller order_controller --resource

# Generate factory for testing
bun strav make:factory order_factory

# Generate policy for authorization
bun strav make:policy order_policy
```

## Schema Evolution

### Adding Fields

```typescript
// Modify schema
export default defineSchema('user', {
  archetype: Archetype.Entity,
  fields: {
    // ... existing fields
    phone: t.string().nullable(),        // New field
    two_factor_enabled: t.boolean().default(false), // New field
  },
})
```

```bash
# Generate migration
bun strav generate:migration --message="add phone and 2FA to users"
```

### Changing Field Types

```typescript
// Before: t.string()
// After: t.text()
description: t.text().nullable(),
```

The migration generator detects the change and creates appropriate ALTER statements.

### Removing Fields

```typescript
// Remove from schema definition
// Migration generator creates DROP COLUMN statements
```

### Renaming Fields

```typescript
// Use migration hints for renames
export default defineSchema('user', {
  fields: {
    full_name: t.string().required(), // was: display_name
  },
  hints: {
    renames: { display_name: 'full_name' }
  }
})
```

## Advanced Patterns

### Polymorphic Relationships

```typescript
// Comments can belong to posts, videos, etc.
export default defineSchema('comment', {
  archetype: Archetype.Contribution,
  fields: {
    content: t.text().required(),
    commentable_id: t.uuid().required(),
    commentable_type: t.string().required(),
    author_id: t.reference('user'),
  },
})
```

### JSON Schema Validation

```typescript
export default defineSchema('product', {
  fields: {
    metadata: t.jsonb().schema({
      type: 'object',
      properties: {
        weight: { type: 'number', minimum: 0 },
        dimensions: {
          type: 'object',
          properties: {
            length: { type: 'number' },
            width: { type: 'number' },
            height: { type: 'number' }
          },
          required: ['length', 'width', 'height']
        }
      }
    }),
  },
})
```

### Computed Fields

```typescript
export default defineSchema('user', {
  fields: {
    first_name: t.string().required(),
    last_name: t.string().required(),
  },
  computed: {
    full_name: '(first_name || \' \' || last_name)',
    initials: 'UPPER(LEFT(first_name, 1) || LEFT(last_name, 1))',
  }
})
```

## Schema Validation

### Runtime Validation

Schemas enable runtime validation:

```typescript
// In your controller
async function createUser(ctx: Context) {
  const data = await ctx.request.json()

  // Automatic validation from schema
  const validation = UserSchema.validate(data)

  if (validation.errors.length > 0) {
    return ctx.json({ errors: validation.errors }, 400)
  }

  const user = await User.create(validation.data)
  return ctx.json({ user })
}
```

### Testing with Schemas

```typescript
// tests/schemas/user.test.ts
import { test, expect } from 'bun:test'
import UserSchema from '../../database/schemas/user.ts'

test('user schema validates email', () => {
  const valid = UserSchema.validate({
    email: 'john@example.com',
    name: 'John Doe'
  })

  expect(valid.errors).toHaveLength(0)

  const invalid = UserSchema.validate({
    email: 'not-an-email',
    name: 'John Doe'
  })

  expect(invalid.errors).toContain('email must be a valid email address')
})
```

## Best Practices

### 1. Schema Design Principles

- **Use appropriate archetypes** for semantic clarity
- **Start with required fields** and add optional ones later
- **Prefer foreign keys** over denormalized data
- **Use enums** for constrained values
- **Add validation** at the schema level

### 2. Migration Safety

- **Always review** generated migrations before running
- **Test migrations** on a copy of production data
- **Use transactions** for complex schema changes
- **Keep migrations small** and focused

### 3. Performance Considerations

- **Add indexes** for foreign keys and query patterns
- **Use JSONB** for structured data that needs querying
- **Consider partitioning** for high-volume event tables
- **Use appropriate data types** (don't use TEXT for short strings)

### 4. Team Workflow

- **Schema changes require code review**
- **Document breaking changes** in migration messages
- **Use feature flags** for gradual schema rollouts
- **Coordinate deployments** with schema changes

Schema-driven development with Spring ensures your database, application code, and APIs stay perfectly synchronized while providing type safety throughout your entire stack.