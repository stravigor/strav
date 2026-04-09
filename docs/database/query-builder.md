# QueryBuilder

The QueryBuilder provides a fluent, type-safe interface for constructing and executing SQL queries. It supports complex WHERE conditions, joins, aggregations, pagination, and seamless integration with the ORM.

## Quick Start

```typescript
import { query, transaction } from '@strav/database'
import User from '../app/models/user'

// Basic query
const users = await query(User)
  .where('active', true)
  .orderBy('createdAt', 'desc')
  .all()

// With transaction

await transaction(async (trx) => {
  const users = await query(User, trx)
    .where('role', 'admin')
    .all()
})
```

## Complete Method Reference

### WHERE Conditions

#### Basic WHERE

```typescript
// Simple equality (operator defaults to '=')
query(User).where('status', 'active')

// With operator
query(User).where('age', '>=', 18)
query(User).where('name', 'LIKE', 'John%')

// Grouped conditions with callback
query(User).where(q => {
  q.where('active', true)
    .orWhere('premium', true)
})
```

#### IN/NOT IN Queries

```typescript
query(User).whereIn('role', ['admin', 'moderator'])
query(User).whereNotIn('status', ['banned', 'suspended'])
```

#### NULL Checks

```typescript
query(User).whereNull('deletedAt')
query(User).whereNotNull('emailVerifiedAt')
```

#### BETWEEN Ranges

```typescript
query(User).whereBetween('age', 18, 65)
query(Product).whereBetween('price', 10.00, 99.99)
```

#### Raw SQL Conditions

```typescript
// With parameter binding (safe)
query(User).whereRaw('"email" ILIKE $1', ['%@gmail.com'])

// Complex expressions
query(Order).whereRaw('DATE("createdAt") = CURRENT_DATE')
```

### OR Conditions

All WHERE methods have OR variants that add conditions with OR logic:

```typescript
query(User)
  .where('role', 'admin')
  .orWhere('role', 'super_admin')

query(Product)
  .where('category', 'electronics')
  .orWhereIn('featured', [true])
  .orWhereBetween('discount', 20, 50)

// Grouped OR conditions
query(User).orWhere(q => {
  q.where('premium', true)
    .where('credits', '>', 0)
})
```

#### Complete OR Methods
- `orWhere(column, operatorOrValue?, value?)`
- `orWhereIn(column, values)`
- `orWhereNotIn(column, values)`
- `orWhereNull(column)`
- `orWhereNotNull(column)`
- `orWhereBetween(column, low, high)`
- `orWhereRaw(sql, params?)`

### JOIN Operations

```typescript
// INNER JOIN
const results = await query(User)
  .innerJoin(Profile).on('User.id', '=', 'Profile.userId')
  .select('User.email', 'Profile.bio')
  .all()

// LEFT JOIN
query(Post)
  .leftJoin(Comment).on('Post.id', '=', 'Comment.postId')
  .select('Post.*', 'COUNT(Comment.id) as commentCount')
  .groupBy('Post.id')
  .all()

// RIGHT JOIN
query(Order)
  .rightJoin(Product).on('Order.productId', '=', 'Product.id')
  .all()

// Multiple joins
query(User)
  .innerJoin(Profile).on('User.id', '=', 'Profile.userId')
  .leftJoin(Team).on('User.teamId', '=', 'Team.id')
  .all()
```

### SELECT & Projection

```typescript
// Specific columns
query(User).select('id', 'email', 'name').all()

// With table prefix
query(User)
  .innerJoin(Profile).on('User.id', '=', 'Profile.userId')
  .select('User.email', 'Profile.bio', 'Profile.avatar')
  .all()

// Distinct values
query(Order).select('status').distinct().all()

// Single column values (returns array of values, not objects)
const emails: string[] = await query(User).pluck<string>('email')
const ids: number[] = await query(Product).pluck<number>('id')
```

### Ordering, Limiting & Pagination

```typescript
// ORDER BY
query(User).orderBy('createdAt', 'desc').all()
query(Product).orderBy('category', 'asc').orderBy('price', 'desc').all()

// LIMIT & OFFSET
query(Post).limit(10).all()
query(Post).offset(20).limit(10).all()

// Pagination with metadata
const result = await query(User)
  .where('active', true)
  .orderBy('name', 'asc')
  .paginate(2, 20) // page 2, 20 per page

/*
result = {
  data: User[],
  meta: {
    page: 2,
    perPage: 20,
    total: 145,
    lastPage: 8,
    from: 21,  // 1-based index
    to: 40     // 1-based index
  }
}
*/
```

### Aggregation Functions

```typescript
// COUNT
const totalUsers = await query(User).count()
const activeUsers = await query(User).where('active', true).count()

// SUM
const totalRevenue = await query(Order).sum('amount')
const monthlyRevenue = await query(Order)
  .whereRaw('DATE("createdAt") >= DATE_TRUNC(\'month\', CURRENT_DATE)')
  .sum('amount')

// AVERAGE
const avgAge = await query(User).avg('age')
const avgOrderValue = await query(Order)
  .where('status', 'completed')
  .avg('total')

// MIN/MAX
const minPrice = await query(Product).min('price')
const maxScore = await query(Review).max('rating')
const oldestUser = await query(User).min('createdAt')

// EXISTS check
const hasAdmins = await query(User).where('role', 'admin').exists()
if (!hasAdmins) {
  console.log('No admins found!')
}
```

### GROUP BY & HAVING

```typescript
// Simple grouping
const usersByRole = await query(User)
  .select('role', 'COUNT(*) as count')
  .groupBy('role')
  .all()

// Multiple group columns
query(Order)
  .select('status', 'DATE(createdAt) as date', 'SUM(total) as revenue')
  .groupBy('status', 'DATE(createdAt)')
  .orderBy('date', 'desc')
  .all()

// HAVING clause for aggregate conditions
query(Product)
  .select('category', 'AVG(price) as avgPrice')
  .groupBy('category')
  .having('AVG(price)', '>', 100)
  .all()

// Raw HAVING for complex conditions
query(User)
  .select('teamId', 'COUNT(*) as members')
  .groupBy('teamId')
  .havingRaw('COUNT(*) >= $1', [5])
  .all()
```

### Data Modification

#### UPDATE Operations

```typescript
// Update matching records (returns affected count)
const affected = await query(User)
  .where('lastLoginAt', '<', oneYearAgo)
  .update({ status: 'inactive' })

// Update with transaction
await transaction(async (trx) => {
  await query(Product, trx)
    .where('category', 'electronics')
    .update({ discount: 15 })
})
```

#### INCREMENT/DECREMENT

```typescript
// Increment by 1 (default)
await query(Post).where('id', postId).increment('views')

// Increment by specific amount
await query(User).where('id', userId).increment('credits', 100)

// Decrement
await query(Product).where('id', productId).decrement('stock', 5)

// Multiple operations
await query(Cart)
  .where('userId', userId)
  .where('productId', productId)
  .increment('quantity', 2)
```

#### DELETE Operations

```typescript
// Soft delete (if model has softDeletes = true)
const deleted = await query(User)
  .where('status', 'banned')
  .delete()

// Force hard delete
const forceDeleted = await query(User)
  .where('createdAt', '<', twoYearsAgo)
  .forceDelete()

// Delete with join condition
await query(Comment)
  .innerJoin(Post).on('Comment.postId', '=', 'Post.id')
  .where('Post.status', 'archived')
  .delete()
```

### Soft Delete Control

```typescript
// Include soft-deleted records
const allUsers = await query(User).withTrashed().all()

// Only soft-deleted records
const deletedUsers = await query(User).onlyTrashed().all()

// Combining with other conditions
query(User)
  .withTrashed()
  .where('role', 'admin')
  .orderBy('deletedAt', 'desc')
  .all()
```

### Eager Loading Relationships

```typescript
// Load single relationship
const users = await query(User)
  .with('profile')
  .all()

// Load multiple relationships
const posts = await query(Post)
  .with('author', 'comments', 'tags')
  .all()

// With conditions
const orders = await query(Order)
  .with('items', 'customer')
  .where('status', 'pending')
  .all()
```

### Model Scopes

```typescript
// Assuming User model has defined scopes
class User extends BaseModel {
  static scopeActive(query: QueryBuilder<User>) {
    return query.where('active', true).whereNotNull('emailVerifiedAt')
  }

  static scopePremium(query: QueryBuilder<User>) {
    return query.where('plan', 'premium')
  }
}

// Using scopes
const activeUsers = await query(User).scope('active').all()
const premiumUsers = await query(User).scope('premium').scope('active').all()
```

### Chunked Processing

Process large datasets in memory-efficient chunks:

```typescript
// Process users in chunks of 100
await query(User)
  .where('needsProcessing', true)
  .chunk(100, async (users) => {
    for (const user of users) {
      await processUser(user)
    }
  })

// With early termination
await query(Order)
  .where('status', 'pending')
  .chunk(50, async (orders) => {
    for (const order of orders) {
      await processOrder(order)
      if (shouldStop()) {
        return false // Stop chunking
      }
    }
  })
```

### SQL Inspection

Debug queries by inspecting generated SQL without execution:

```typescript
const query = query(User)
  .where('active', true)
  .whereIn('role', ['admin', 'moderator'])
  .orderBy('createdAt', 'desc')

const { sql, params } = query.toSQL()
console.log('SQL:', sql)
console.log('Params:', params)
// SQL: SELECT * FROM "user" WHERE "active" = $1 AND "role" IN ($2, $3) ORDER BY "created_at" DESC
// Params: [true, 'admin', 'moderator']
```

## Advanced Patterns

### Complex Filtering

```typescript
// Dynamic filter building
function buildUserFilter(query: QueryBuilder<User>, filters: UserFilters) {
  if (filters.search) {
    query.where(q => {
      q.where('name', 'ILIKE', `%${filters.search}%`)
        .orWhere('email', 'ILIKE', `%${filters.search}%`)
    })
  }

  if (filters.roles?.length) {
    query.whereIn('role', filters.roles)
  }

  if (filters.minAge) {
    query.whereRaw('EXTRACT(YEAR FROM AGE(birthDate)) >= $1', [filters.minAge])
  }

  return query
}

const filtered = await buildUserFilter(query(User), filters).paginate()
```

### Subqueries with Callbacks

```typescript
// Complex nested conditions
const results = await query(Product)
  .where('active', true)
  .where(q => {
    q.where(sub => {
      sub.where('stock', '>', 0)
        .orWhere('preorder', true)
    })
    .where('price', '<', 100)
  })
  .all()

// Equivalent to:
// WHERE active = true
//   AND ((stock > 0 OR preorder = true) AND price < 100)
```

### Report Queries

```typescript
// Sales report by month
const monthlySales = await query(Order)
  .select(
    'DATE_TRUNC(\'month\', createdAt) as month',
    'COUNT(*) as orderCount',
    'SUM(total) as revenue',
    'AVG(total) as avgOrderValue'
  )
  .where('status', 'completed')
  .whereBetween('createdAt', startDate, endDate)
  .groupBy('DATE_TRUNC(\'month\', createdAt)')
  .orderBy('month', 'desc')
  .all()

// Top customers
const topCustomers = await query(Order)
  .innerJoin(User).on('Order.userId', '=', 'User.id')
  .select(
    'User.id',
    'User.name',
    'User.email',
    'COUNT(Order.id) as orderCount',
    'SUM(Order.total) as totalSpent'
  )
  .where('Order.status', 'completed')
  .groupBy('User.id', 'User.name', 'User.email')
  .having('COUNT(Order.id)', '>', 5)
  .orderBy('totalSpent', 'desc')
  .limit(10)
  .all()
```

### Batch Operations

```typescript
// Archive old records in batches
async function archiveOldPosts() {
  const oneYearAgo = DateTime.now().minus({ years: 1 }).toJSDate()

  await query(Post)
    .where('createdAt', '<', oneYearAgo)
    .where('archived', false)
    .chunk(100, async (posts) => {
      const ids = posts.map(p => p.id)

      // Archive posts
      await query(Post)
        .whereIn('id', ids)
        .update({ archived: true, archivedAt: new Date() })

      // Log the operation
      console.log(`Archived ${ids.length} posts`)
    })
}
```

### Transaction Patterns

```typescript
// Complex transaction with multiple queries
const order = await transaction(async (trx) => {
  // Check stock
  const product = await query(Product, trx)
    .where('id', productId)
    .first()

  if (!product || product.stock < quantity) {
    throw new Error('Insufficient stock')
  }

  // Decrement stock
  await query(Product, trx)
    .where('id', productId)
    .decrement('stock', quantity)

  // Create order
  const order = await Order.create({
    userId,
    productId,
    quantity,
    total: product.price * quantity
  }, trx)

  // Update user stats
  await query(User, trx)
    .where('id', userId)
    .increment('totalOrders')
    .increment('totalSpent', order.total)

  return order
})
```

## Performance Tips

### 1. Use Indexes

Ensure columns used in WHERE, JOIN, and ORDER BY have appropriate indexes:

```typescript
// Check query performance with EXPLAIN
const { sql } = query(User)
  .where('email', 'user@example.com')
  .toSQL()

// Run in database: EXPLAIN ANALYZE <sql>
```

### 2. Limit Selected Columns

Only select columns you need:

```typescript
// Bad - selects all columns
const users = await query(User).all()

// Good - selects only needed columns
const users = await query(User)
  .select('id', 'name', 'email')
  .all()
```

### 3. Use Pagination for Large Results

```typescript
// Bad - loads all records into memory
const allUsers = await query(User).all()

// Good - paginated results
const page1 = await query(User).paginate(1, 100)

// Good - chunked processing
await query(User).chunk(100, async (users) => {
  // Process batch
})
```

### 4. Optimize Aggregations

```typescript
// Use database aggregations instead of loading all records
// Bad
const orders = await query(Order).where('userId', userId).all()
const total = orders.reduce((sum, o) => sum + o.total, 0)

// Good
const total = await query(Order).where('userId', userId).sum('total')
```

### 5. Avoid N+1 Queries

Use eager loading for relationships:

```typescript
// Bad - N+1 queries
const posts = await query(Post).all()
for (const post of posts) {
  post.author = await User.find(post.authorId) // N queries!
}

// Good - 2 queries total with eager loading
const posts = await query(Post).with('author').all()
```

## Column Name Resolution

The QueryBuilder automatically handles column name resolution:

```typescript
// 'email' → "user"."email" (primary table + snake_case)
query(User).where('email', 'test@example.com')

// 'User.email' → "user"."email" (explicit model reference)
query(User).where('User.email', 'test@example.com')

// 'Profile.userId' → "profile"."user_id" (cross-table + case conversion)
query(User)
  .innerJoin(Profile).on('User.id', '=', 'Profile.userId')
```

## Error Handling

```typescript
import { ModelNotFoundError } from '@strav/database'

try {
  const user = await query(User)
    .where('email', 'nonexistent@example.com')
    .firstOrFail()
} catch (error) {
  if (error instanceof ModelNotFoundError) {
    console.log('User not found')
  }
}
```

## TypeScript Support

The QueryBuilder is fully typed and provides IntelliSense support:

```typescript
// Type-safe model querying
const users: User[] = await query(User).all()
const user: User | null = await query(User).first()
const user: User = await query(User).firstOrFail()

// Typed aggregations
const count: number = await query(User).count()
const sum: number = await query(Order).sum('total')

// Typed pluck results
const emails: string[] = await query(User).pluck<string>('email')
const ids: number[] = await query(Product).pluck<number>('id')

// Typed pagination
const result: PaginationResult<User> = await query(User).paginate()
```