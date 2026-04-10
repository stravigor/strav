# @strav/spring

The flagship framework scaffolding tool for the Strav ecosystem - the Laravel of the Bun ecosystem.

## Overview

**@strav/spring** is Strav's answer to Laravel's `laravel new` command. It creates a complete, production-ready application structure that showcases all of Strav's unique strengths:

- **Schema-driven database design** with TypeScript DSL
- **Vue islands architecture** for interactive components
- **Multi-domain PostgreSQL support** with complete tenant isolation
- **Snake case conventions** throughout the codebase
- **TypeScript-first** development experience

## Quick Start

```bash
# Interactive prompt (recommended for first-time users)
bunx @strav/spring my-app

# Full-stack application with Vue islands
bunx @strav/spring my-blog --web

# Headless REST API
bunx @strav/spring my-api --api
```

## Philosophy

Spring embodies Strav's core philosophy:

1. **Convention over Configuration** - Predictable directory structure and naming
2. **Schema-driven Development** - Database schemas as the single source of truth
3. **Vue Islands** - Progressive enhancement with server-side templates + client-side interactivity
4. **Type Safety** - Full TypeScript integration from database to frontend
5. **Developer Experience** - Rich tooling and instant productivity

## Directory Structure

Spring creates a Laravel-inspired directory structure adapted for Strav conventions:

```
my-app/
├── app/                      # Application logic
│   ├── controllers/          # HTTP controllers (snake_case)
│   ├── models/               # Database models (generated from schemas)
│   ├── middleware/           # Custom middleware
│   ├── providers/            # Service providers
│   ├── policies/             # Authorization policies
│   ├── jobs/                 # Queue jobs
│   ├── mail/                 # Mail templates
│   └── services/             # Business logic services
├── config/                   # Configuration files
│   ├── app.ts                # Application settings
│   ├── database.ts           # Database configuration
│   ├── view.ts               # View engine settings
│   └── session.ts            # Session configuration
├── database/                 # Database layer
│   ├── schemas/              # Schema definitions (TypeScript DSL)
│   │   └── public/           # Main application schemas
│   ├── migrations/           # Generated migrations
│   │   └── public/           # Generated from schemas
│   ├── seeders/              # Database seeders
│   └── factories/            # Model factories for testing
├── resources/                # Frontend resources
│   ├── views/                # Server-side templates (.strav files)
│   ├── css/                  # Stylesheets
│   └── ts/                   # TypeScript assets
│       └── islands/          # Vue.js islands
├── routes/                   # Route definitions
├── storage/                  # Application storage
│   ├── logs/                 # Application logs
│   ├── cache/                # File cache
│   └── uploads/              # User uploads
├── tests/                    # Test files
├── public/                   # Static files (web template only)
├── index.ts                  # Application entry point
├── strav.ts                  # CLI tool (like artisan)
├── .env                      # Environment variables
├── package.json              # Dependencies and scripts
└── tsconfig.json             # TypeScript configuration
```

## Template Types

### Web Template (`--web`)

The **web** template creates a full-stack application with:

- **Server-side rendering** with `.strav` templates
- **Vue islands** for interactive components
- **Session management** and authentication scaffolding
- **Static file serving** from `public/` directory
- **Asset versioning** for cache busting
- **Complete UI examples** demonstrating all features

**Perfect for:**
- Traditional web applications
- Content management systems
- E-commerce platforms
- Admin dashboards
- Any app requiring server-side rendering + interactivity

### API Template (`--api`)

The **api** template creates a headless REST API with:

- **JSON-only responses** with proper error handling
- **CORS configuration** for frontend consumption
- **RESTful controllers** with full CRUD operations
- **No view layer** - pure API endpoints
- **Optimized for performance** - minimal dependencies

**Perfect for:**
- Mobile app backends
- Microservices
- SPA backends
- Third-party integrations
- Headless CMS backends

## Getting Started

### 1. Create Your Application

```bash
# Interactive mode - recommended for beginners
bunx @strav/spring my-app

# Or specify template directly
bunx @strav/spring my-blog --web --db=blog_database
```

### 2. Navigate and Install

```bash
cd my-app
bun install  # Install dependencies
```

### 3. Configure Database

Edit `.env` with your database credentials:

```env
DB_HOST=127.0.0.1
DB_PORT=5432
DB_USER=your_username
DB_PASSWORD=your_password
DB_DATABASE=my_app
```

### 4. Run Migrations and Seed

```bash
# Generate and run migrations from schemas
bun strav generate:migration --scope=public --message="initial schema"
bun strav migrate --scope=public

# Seed with sample data
bun strav seed
```

### 5. Start Development Server

```bash
bun run dev  # Starts server with hot reload
```

Visit `http://localhost:3000` to see your application!

## Development Workflow

### Schema-Driven Development

1. **Define schemas** in `database/schemas/public/`:

```typescript
// database/schemas/public/post.ts
import { defineSchema, t, Archetype } from '@strav/database'

export default defineSchema('post', {
  archetype: Archetype.Entity,
  fields: {
    id: t.uuid().primaryKey(),
    title: t.string().required(),
    slug: t.string().unique().required(),
    content: t.text().required(),
    status: t.enum(['draft', 'published', 'archived']).default('draft'),
    author: t.reference('user'),
  },
})
```

2. **Generate migrations**:

```bash
bun strav generate:migration --scope=public --message="add post schema"
```

3. **Run migrations**:

```bash
bun strav migrate --scope=public
```

4. **Generate models** (optional - can be auto-generated):

```bash
bun strav generate:models --scope=public
```

### Vue Islands Development

1. **Create island components** in `resources/ts/islands/`:

```vue
<!-- resources/ts/islands/post_editor.vue -->
<template>
  <div class="post-editor">
    <input v-model="title" placeholder="Post title" />
    <textarea v-model="content" placeholder="Write your post..."></textarea>
    <button @click="save" :disabled="saving">
      {{ saving ? 'Saving...' : 'Save Post' }}
    </button>
  </div>
</template>

<script setup>
import { ref } from 'vue'

const props = defineProps({
  initialTitle: { type: String, default: '' },
  initialContent: { type: String, default: '' }
})

const title = ref(props.initialTitle)
const content = ref(props.initialContent)
const saving = ref(false)

async function save() {
  saving.value = true
  // API call to save post
  await fetch('/api/posts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: title.value, content: content.value })
  })
  saving.value = false
}
</script>
```

2. **Use in templates**:

```html
<!-- resources/views/pages/create_post.strav -->
@layout('layouts/app')

@section('content')
  <h1>Create New Post</h1>
  <vue:post-editor />
@end
```

### Controller Development

```typescript
// app/controllers/post_controller.ts
import type { Context } from '@strav/http'
import { query } from '@strav/database'
import { Controller } from './controller.ts'
import Post from '../models/post.ts'

export default class PostController extends Controller {
  async index(ctx: Context) {
    const posts = await query(Post)
      .where('status', 'published')
      .orderBy('created_at', 'DESC')
      .limit(10)
      .all()

    return ctx.view('pages/posts/index', { posts })
  }

  async show(ctx: Context) {
    const { slug } = ctx.params
    const post = await query(Post)
      .where('slug', slug)
      .where('status', 'published')
      .first()

    if (!post) {
      return this.notFound(ctx, 'Post not found')
    }

    return ctx.view('pages/posts/show', { post })
  }
}
```

## CLI Commands

Once your application is created, you can use the built-in `strav.ts` CLI:

```bash
# Schema and database
bun strav make:schema post --archetype=entity
bun strav generate:migration --scope=public --message="add post schema"
bun strav migrate --scope=public
bun strav rollback --scope=public

# Code generation
bun strav make:controller post_controller
bun strav make:middleware auth_middleware
bun strav make:policy post_policy
bun strav make:job send_notification_job
bun strav make:mail welcome_mail
bun strav make:service payment_service
bun strav make:factory post_factory

# Vue islands
bun strav make:island post_editor
bun strav make:island comment_form

# Database operations
bun strav seed
bun strav seed --class=PostSeeder

# Development helpers
bun strav route:list
bun strav compare  # Compare schemas vs database
```

## Best Practices

### 1. Schema Design

- Use appropriate **archetypes** for your models
- Define **relationships** clearly with `t.reference()`
- Add **validation** at the schema level
- Use **enums** for constrained values

### 2. Vue Islands

- Keep islands **focused** on single responsibilities
- Use **TypeScript** for props definitions
- Handle **loading states** and errors gracefully
- Implement **accessibility** features

### 3. Controllers

- Extend the base `Controller` class
- Use **snake_case** for file names
- Keep controllers **thin** - move logic to services
- Return proper **HTTP status codes**

### 4. Testing

- Use the provided **factory** patterns
- Test **both API and UI** functionality
- Mock external services in tests
- Write **integration tests** for critical paths

## Configuration

### Environment Variables

Common `.env` variables for Spring applications:

```env
# Application
APP_ENV=local
APP_KEY=your-secret-key
APP_DEBUG=true
APP_URL=http://localhost:3000
APP_PORT=3000

# Database
DB_HOST=127.0.0.1
DB_PORT=5432
DB_USER=your_username
DB_PASSWORD=your_password
DB_DATABASE=your_database

# Sessions (web template)
SESSION_SECRET=your-session-secret
SESSION_COOKIE_NAME=session

# Views (web template)
VIEW_CACHE=false
VIEW_DIRECTORY=resources/views
```

### Package Scripts

Spring applications come with these npm scripts:

```json
{
  "scripts": {
    "dev": "bun --hot index.ts",      // Development with hot reload
    "start": "bun index.ts",          // Production server
    "test": "bun test tests/",        // Run tests
    "typecheck": "tsc --noEmit"       // Type checking
  }
}
```

## Deployment

### Building for Production

1. **Set production environment**:

```env
APP_ENV=production
APP_DEBUG=false
VIEW_CACHE=true
```

2. **Build Vue islands**:

```bash
# Islands are auto-built on server start, or manually:
bun strav build:islands
```

3. **Run migrations**:

```bash
bun strav migrate --scope=public
```

4. **Start the server**:

```bash
bun start
```

## Examples

### Blog Application

```bash
bunx @strav/spring my-blog --web --db=blog_db
cd my-blog

# Add post schema
# Create post_controller.ts
# Add blog routes
# Create post templates with Vue islands for comments
```

### API for Mobile App

```bash
bunx @strav/spring mobile-api --api --db=mobile_app_db
cd mobile-api

# Add user authentication
# Create resource controllers
# Set up proper CORS
# Add API documentation
```

### E-commerce Platform

```bash
bunx @strav/spring shop --web --db=shop_db
cd shop

# Add product, order, customer schemas
# Create shopping cart Vue islands
# Set up payment processing
# Add admin dashboard
```

## Migration from Laravel

If you're coming from Laravel, here's how Strav concepts map:

| Laravel | Strav Spring |
|---------|--------------|
| `php artisan make:model` | `bun strav make:schema` |
| Blade templates | `.strav` templates |
| Laravel Mix | Built-in asset processing |
| Eloquent ORM | Strav ORM with decorators |
| Artisan commands | `strav.ts` CLI |
| Service providers | Service providers |
| Middleware | Middleware |

## Troubleshooting

### Common Issues

**"Workspace dependency not found"**
- Ensure you're running commands inside a Strav workspace
- Check that all `@strav/*` packages are available

**"Vue islands not rendering"**
- Check that `@islands` directive is in your layout
- Verify islands are being built (`public/islands.js` exists)
- Ensure Vue is installed as a dependency

**"Database connection failed"**
- Verify database credentials in `.env`
- Ensure PostgreSQL is running
- Check database exists and user has permissions

### Getting Help

- Check the [Strav documentation](../README.md)
- Review example applications in the templates
- Join the Strav community discussions

Spring represents the best of Laravel's developer experience adapted for the modern TypeScript and Bun ecosystem. Happy building! 🚀