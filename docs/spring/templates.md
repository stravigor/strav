# Spring Templates

Spring provides two carefully crafted templates that showcase different aspects of the Strav ecosystem. Each template creates a complete, production-ready application structure.

## Template Overview

| Template | Purpose | Best For | Key Features |
|----------|---------|----------|--------------|
| **Web** | Full-stack applications | Traditional web apps, CMSs, dashboards | Vue islands, server-side rendering, sessions |
| **API** | Headless REST APIs | Mobile backends, microservices, SPAs | JSON responses, CORS, optimized performance |

## Web Template (`--web`)

The **web template** creates a comprehensive full-stack application showcasing Strav's complete feature set.

### Generated Structure

```
my-app/
├── app/
│   ├── controllers/
│   │   ├── controller.ts           # Base controller class
│   │   └── home_controller.ts      # Demo home controller
│   └── models/
│       └── user.ts                 # User model with decorators
├── config/
│   ├── app.ts                      # Application configuration
│   ├── database.ts                 # Database settings
│   ├── encryption.ts               # Encryption configuration
│   ├── session.ts                  # Session management
│   └── view.ts                     # View engine settings
├── database/
│   ├── schemas/
│   │   └── user.ts                 # User schema definition
│   ├── migrations/                 # Auto-generated migrations
│   ├── seeders/
│   │   ├── database_seeder.ts      # Main seeder
│   │   └── user_seeder.ts          # User seeder
│   └── factories/
│       └── user_factory.ts         # User factory for testing
├── resources/
│   ├── views/
│   │   ├── layouts/
│   │   │   └── app.strav           # Main layout template
│   │   └── pages/
│   │       ├── home.strav          # Homepage with islands demo
│   │       └── users.strav         # Users list page
│   ├── css/
│   │   └── app.css                 # Base styles
│   └── ts/islands/                 # Vue islands directory
│       ├── counter.vue             # Interactive counter demo
│       ├── user_search.vue         # Search component
│       └── user_manager.vue        # CRUD management component
├── routes/
│   └── routes.ts                   # Web route definitions
├── public/                         # Static files directory
├── index.ts                        # Web server entry point
└── package.json                    # Includes Vue dependency
```

### Key Features

#### 1. Vue Islands Architecture

The web template demonstrates Strav's unique Vue islands approach:

**Server-side Templates (.strav files):**
```html
<!-- resources/views/pages/home.strav -->
@layout('layouts/app')

@section('content')
  <h1>Welcome to {{ title }}</h1>

  {{-- Interactive Vue component --}}
  <vue:counter :initial="5" label="Click me!" />

  {{-- Component with data binding --}}
  <vue:user-search :userCount="{{ userCount }}" />
@end
```

**Vue Island Components:**
```vue
<!-- resources/ts/islands/counter.vue -->
<template>
  <div class="counter">
    <button @click="count--">-</button>
    <span>{{ count }}</span>
    <button @click="count++">+</button>
    <span>{{ label }}</span>
  </div>
</template>

<script setup>
import { ref } from 'vue'

const props = defineProps({
  initial: { type: Number, default: 0 },
  label: { type: String, default: 'Counter' }
})

const count = ref(props.initial)
</script>
```

#### 2. Session Management

Includes complete session configuration:

```typescript
// config/session.ts
export default {
  secret: env('SESSION_SECRET'),
  cookieName: env('SESSION_COOKIE_NAME', 'session'),
  maxAge: 1000 * 60 * 60 * 24 * 7, // 1 week
  secure: env('APP_ENV') === 'production',
  httpOnly: true,
  sameSite: 'lax' as const,
}
```

#### 3. Asset Management

Built-in asset versioning and serving:

```typescript
// config/view.ts
export default {
  directory: 'resources/views',
  cache: env.bool('VIEW_CACHE', true),
  assets: ['/css/app.css', '/islands.js'],
}
```

#### 4. Development Features

- **Hot reload** for both server and Vue islands
- **Automatic island building** with file watching
- **Static file serving** from public directory
- **Template caching** with development reloading

### Island Building Process

The web template includes automatic Vue island building:

```typescript
// index.ts
import { IslandBuilder } from '@strav/view'

// Build Vue islands for development
if (process.env.NODE_ENV !== 'production') {
  const islands = new IslandBuilder({
    islandsDir: './resources/ts/islands',
    outDir: './public',
    outFile: 'islands.js',
  })
  await islands.build()
  islands.watch() // Auto-rebuild on changes
}
```

### Demo Components

The web template includes three demo Vue islands:

1. **Counter** - Basic state management
2. **User Search** - Form handling and API simulation
3. **User Manager** - Complex CRUD operations with loading states

## API Template (`--api`)

The **API template** creates a lean, focused REST API optimized for performance and JSON responses.

### Generated Structure

```
my-api/
├── app/
│   ├── controllers/
│   │   ├── controller.ts           # Base API controller
│   │   └── user_controller.ts      # RESTful user controller
│   └── models/
│       └── user.ts                 # User model
├── config/
│   ├── app.ts                      # Application configuration
│   ├── database.ts                 # Database settings
│   ├── encryption.ts               # Encryption configuration
│   └── http.ts                     # HTTP/CORS configuration
├── database/                       # Same structure as web template
│   ├── schemas/
│   ├── migrations/
│   ├── seeders/
│   └── factories/
├── routes/
│   └── routes.ts                   # API route definitions
├── tests/
│   └── example.test.ts             # Basic test setup
├── index.ts                        # API server entry point
└── package.json                    # No Vue dependency
```

### Key Features

#### 1. RESTful Controllers

Complete CRUD operations with proper HTTP status codes:

```typescript
// app/controllers/user_controller.ts
export default class UserController extends Controller {
  async index(ctx: Context) {
    const users = await User.all()
    return this.respond(ctx, { users })
  }

  async show(ctx: Context) {
    const { id } = ctx.params
    const user = await User.find(id)

    if (!user) {
      return this.notFound(ctx, 'User not found')
    }

    return this.respond(ctx, { user })
  }

  async store(ctx: Context) {
    const { email, name, password } = await ctx.request.json()

    if (!email || !name || !password) {
      return this.error(ctx, 'Email, name, and password are required')
    }

    const user = await User.create({
      id: crypto.randomUUID(),
      email,
      name,
      password_hash: await Bun.password.hash(password),
    })

    return this.respond(ctx, { user }, 201)
  }
}
```

#### 2. CORS Configuration

Production-ready CORS setup:

```typescript
// config/http.ts
export default {
  port: env.int('APP_PORT', 3000),
  cors: {
    enabled: true,
    origin: ['http://localhost:3000', 'http://localhost:5173'],
    credentials: true,
  },
}
```

#### 3. API Route Structure

Clean RESTful routing:

```typescript
// routes/routes.ts
export default function (router: Router) {
  // Health check
  router.get('/health', async (ctx) => {
    return ctx.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      app: 'my-api',
      version: '0.1.0'
    })
  })

  // API routes
  router.group('/api/v1', () => {
    // User resource routes
    router.get('/users', [UserController, 'index'])
    router.get('/users/:id', [UserController, 'show'])
    router.post('/users', [UserController, 'store'])
    router.put('/users/:id', [UserController, 'update'])
    router.delete('/users/:id', [UserController, 'destroy'])
  })
}
```

#### 4. JSON-First Design

All responses are JSON with consistent structure:

```typescript
// Base controller methods
protected async respond<T>(ctx: Context, data: T, status = 200) {
  return ctx.json(data, status)
}

protected async error(ctx: Context, message: string, status = 400) {
  return ctx.json({ error: message }, status)
}

protected async notFound(ctx: Context, message = 'Not found') {
  return ctx.json({ error: message }, 404)
}
```

### Performance Optimizations

The API template is optimized for performance:

- **Minimal dependencies** - No view engine, Vue, or session middleware
- **CORS enabled** for frontend consumption
- **JSON-only responses** with proper Content-Type headers
- **Efficient routing** with grouped endpoints
- **Lean middleware stack**

## Shared Components

Both templates share these foundational elements:

### 1. Database Layer

**Schema Definition (TypeScript DSL):**
```typescript
// database/schemas/user.ts
import { defineSchema, t, Archetype } from '@strav/database'

export default defineSchema('user', {
  archetype: Archetype.Entity,
  fields: {
    id: t.uuid().primaryKey(),
    email: t.string().email().unique().required(),
    name: t.string().required(),
    password_hash: t.string().required(),
    email_verified_at: t.timestamp().nullable(),
    remember_token: t.string(100).nullable(),
  },
})
```

**Generated Model:**
```typescript
// app/models/user.ts
import { Model, column } from '@strav/database'

export default class User extends Model {
  @column({ isPrimary: true })
  declare id: string

  @column()
  declare email: string

  @column()
  declare name: string

  // ... other columns with proper TypeScript types
}
```

### 2. Configuration Structure

Both templates use the same configuration approach:

```typescript
// config/app.ts
export default {
  name: 'my-app',
  env: env('APP_ENV', 'production'),
  debug: env.bool('APP_DEBUG', false),
  url: env('APP_URL', 'http://localhost:3000'),
  port: env.int('APP_PORT', 3000),
  key: env('APP_KEY'),
}
```

### 3. Testing Setup

Both include testing foundations:

```typescript
// tests/example.test.ts
import { test, expect } from 'bun:test'

test('example test', () => {
  expect(1 + 1).toBe(2)
})
```

### 4. Factory Pattern

Consistent factory definitions for testing:

```typescript
// database/factories/user_factory.ts
import { Factory } from '@strav/testing'
import User from '../../app/models/user.ts'

export const UserFactory = Factory.define(User, (seq) => ({
  id: crypto.randomUUID(),
  email: `user-${seq}@example.com`,
  name: `User ${seq}`,
  password_hash: '$2b$10$92IXUNpkjO0rOQ5byMi.Ye4oKoEa3Ro9llC/.og/at2.uheWG/igi',
  email_verified_at: new Date(),
  remember_token: null,
}))
```

## Template Selection Guide

### Choose Web Template When:

- Building traditional web applications
- Need server-side rendering with SEO
- Want progressive enhancement with Vue islands
- Building admin dashboards or content management
- Need session-based authentication
- Want to showcase Strav's full feature set

### Choose API Template When:

- Building mobile app backends
- Creating microservices
- Building SPA backends (React, Vue, Angular frontends)
- Need pure JSON APIs
- Building third-party integrations
- Want maximum performance and minimal footprint

## Customization

### Adding Features to Templates

Both templates are starting points - you can easily add features:

**Add to Web Template:**
- Authentication system
- File uploads
- Real-time features (WebSockets)
- Multi-tenant support
- Background jobs

**Add to API Template:**
- Authentication middleware
- Rate limiting
- API documentation (OpenAPI)
- Webhook handling
- Real-time endpoints

### Template Modifications

You can modify the templates by:

1. **Forking the package** and customizing templates
2. **Creating custom stubs** in your project
3. **Adding generators** to your application CLI
4. **Extending base classes** with additional functionality

Both Spring templates provide solid foundations for building modern web applications and APIs with Strav's powerful features while maintaining clean, maintainable code structures.