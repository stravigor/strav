# Getting Started with Spring

This guide walks you through creating your first Strav application using **@strav/spring**, from installation to deployment.

## Prerequisites

Before you begin, ensure you have:

- **Bun** installed (latest version)
- **PostgreSQL** running locally
- **Basic TypeScript/JavaScript** knowledge
- **Git** for version control (recommended)

### System Requirements

```bash
# Check Bun version
bun --version  # Should be 1.0+

# Check PostgreSQL
psql --version  # Should be 12+
```

## Quick Start (5 Minutes)

### 1. Create Your First Application

```bash
# Create a new web application
bunx @strav/spring my-blog --web --db=blog_db

# Navigate to the project
cd my-blog

# Install dependencies
bun install
```

### 2. Configure Database

Create a PostgreSQL database and update your `.env` file:

```bash
# Create database (using psql)
createdb blog_db

# Or using SQL
psql -c "CREATE DATABASE blog_db;"
```

Update `.env`:
```env
DB_HOST=127.0.0.1
DB_PORT=5432
DB_USER=your_username
DB_PASSWORD=your_password
DB_DATABASE=blog_db
```

### 3. Run Initial Setup

```bash
# Generate and run migrations
bun strav generate:migration --scope=public --message="initial schema"
bun strav migrate --scope=public

# Seed with sample data
bun strav seed
```

### 4. Start Development Server

```bash
bun run dev
```

Visit `http://localhost:3000` - you should see your Strav application running with:
- A welcome page with user count
- Interactive Vue island demos
- Working user management

🎉 **Congratulations!** You've created your first Strav application.

## Detailed Walkthrough

### Understanding the Generated Structure

Let's explore what Spring created for you:

```
my-blog/
├── app/                     # Your application code
├── config/                  # Configuration files
├── database/                # Schemas, migrations, seeders
├── resources/               # Templates and frontend assets
├── routes/                  # Route definitions
├── tests/                   # Test files
├── index.ts                 # Server entry point
└── strav.ts                 # CLI tool
```

### Key Files Explained

#### Server Entry Point (`index.ts`)

```typescript
import 'reflect-metadata'
import { app } from '@strav/kernel'
import { router } from '@strav/http'

// Service providers registration
app
  .use(new ConfigProvider())
  .use(new DatabaseProvider())
  .use(new ViewProvider())
  // ... other providers

// Boot the application
await app.start()

// Start the server
server.start(router)
```

This file orchestrates your entire application startup.

#### CLI Tool (`strav.ts`)

```typescript
#!/usr/bin/env bun
// Your personal "artisan" command for development tasks
```

Use it for migrations, code generation, and more:
```bash
bun strav migrate
bun strav make:controller post_controller
```

#### Configuration (`config/`)

All configuration is centralized and environment-aware:

```typescript
// config/app.ts
export default {
  name: env('APP_NAME', 'my-blog'),
  env: env('APP_ENV', 'production'),
  debug: env.bool('APP_DEBUG', false),
  // ...
}
```

### Your First Feature: Blog Posts

Let's add a blog post feature to understand the development workflow:

#### 1. Create the Schema

```bash
bun strav make:schema post --archetype=entity
```

This creates `database/schemas/public/post.ts`:

```typescript
import { defineSchema, t, Archetype } from '@strav/database'

export default defineSchema('post', {
  archetype: Archetype.Entity,
  fields: {
    id: t.uuid().primaryKey(),
    title: t.string().required(),
    slug: t.string().unique().required(),
    content: t.text().required(),
    status: t.enum(['draft', 'published']).default('draft'),
    author_id: t.reference('user'),
  },
})
```

#### 2. Generate and Run Migration

```bash
bun strav generate:migration --scope=public --message="add post schema"
bun strav migrate --scope=public
```

#### 3. Create the Controller

```bash
bun strav make:controller post_controller --resource
```

Edit `app/controllers/post_controller.ts`:

```typescript
import type { Context } from '@strav/http'
import { query } from '@strav/database'
import { Controller } from './controller.ts'
import Post from '../models/post.ts'

export default class PostController extends Controller {
  async index(ctx: Context) {
    const posts = await query(Post)
      .where('status', 'published')
      .orderBy('created_at', 'DESC')
      .all()

    return ctx.view('posts/index', { posts })
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

    return ctx.view('posts/show', { post })
  }
}
```

#### 4. Add Routes

Edit `routes/routes.ts`:

```typescript
import PostController from '../app/controllers/post_controller.ts'

export default function (router: Router) {
  // ... existing routes

  // Blog routes
  router.get('/posts', [PostController, 'index'])
  router.get('/posts/:slug', [PostController, 'show'])
}
```

#### 5. Create Templates

Create `resources/views/posts/index.strav`:

```html
@layout('layouts/app')

@section('content')
  <h1>Blog Posts</h1>

  <div class="posts">
    @each(post in posts)
      <article class="post-preview">
        <h2>
          <a href="/posts/{{ post.slug }}">{{ post.title }}</a>
        </h2>
        <div class="excerpt">
          {{ post.content.slice(0, 200) }}...
        </div>
      </article>
    @end
  </div>
@end
```

#### 6. Create Factory and Seeder

```bash
bun strav make:factory post_factory
bun strav make:seeder post_seeder
```

Edit `database/factories/post_factory.ts`:

```typescript
import { Factory } from '@strav/testing'
import Post from '../../app/models/post.ts'

export const PostFactory = Factory.define(Post, (seq) => ({
  id: crypto.randomUUID(),
  title: `Blog Post ${seq}`,
  slug: `blog-post-${seq}`,
  content: `This is the content for blog post ${seq}...`,
  status: 'published',
  author_id: '...' // Reference to user
}))
```

#### 7. Seed Data

```bash
bun strav seed --class=PostSeeder
```

#### 8. Test Your Feature

Visit `http://localhost:3000/posts` to see your blog posts!

## Adding Vue Islands

Let's add interactivity to our blog with Vue islands:

### 1. Create a Comment System

```bash
bun strav make:island comment_form
```

Edit `resources/ts/islands/comment_form.vue`:

```vue
<template>
  <div class="comment-form">
    <h3>Leave a Comment</h3>

    <form @submit.prevent="submitComment" v-if="!submitted">
      <div class="field">
        <input
          v-model="form.name"
          type="text"
          placeholder="Your name"
          required
        />
      </div>

      <div class="field">
        <textarea
          v-model="form.comment"
          placeholder="Your comment"
          required
        ></textarea>
      </div>

      <button type="submit" :disabled="submitting">
        {{ submitting ? 'Posting...' : 'Post Comment' }}
      </button>
    </form>

    <div v-else class="success">
      <p>Thanks for your comment!</p>
    </div>
  </div>
</template>

<script setup>
import { ref, reactive } from 'vue'

const props = defineProps({
  postSlug: { type: String, required: true }
})

const form = reactive({
  name: '',
  comment: ''
})

const submitting = ref(false)
const submitted = ref(false)

async function submitComment() {
  submitting.value = true

  try {
    await fetch(`/api/posts/${props.postSlug}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(form)
    })

    submitted.value = true
  } catch (error) {
    console.error('Failed to submit comment:', error)
  }

  submitting.value = false
}
</script>
```

### 2. Use in Templates

Edit `resources/views/posts/show.strav`:

```html
@layout('layouts/app')

@section('content')
  <article class="post">
    <h1>{{ post.title }}</h1>
    <div class="content">
      {{ post.content }}
    </div>
  </article>

  {{-- Interactive comment form --}}
  <vue:comment-form :postSlug="'{{ post.slug }}'" />
@end
```

### 3. Add API Endpoint

Edit `routes/routes.ts`:

```typescript
// API routes for island interactions
router.group('/api', () => {
  router.post('/posts/:slug/comments', [PostController, 'storeComment'])
})
```

## Development Workflow

### Daily Development Commands

```bash
# Start development server with hot reload
bun run dev

# Generate new migration after schema changes
bun strav generate:migration -m "add comments table"

# Run migrations
bun strav migrate

# Create new controller
bun strav make:controller comment_controller

# Create new island
bun strav make:island like_button

# Run tests
bun test

# Check types
bun run typecheck
```

### Schema Evolution Workflow

1. **Modify schema files** in `database/schemas/`
2. **Generate migration**: `bun strav generate:migration`
3. **Review generated SQL** in `database/migrations/`
4. **Run migration**: `bun strav migrate`
5. **Update models** if needed

### Vue Islands Development

1. **Create island**: `bun strav make:island component_name`
2. **Develop component** in `resources/ts/islands/`
3. **Use in template**: `<vue:component-name :prop="value" />`
4. **Islands auto-rebuild** on file changes

## Environment Setup

### Development Environment

Your `.env` file for development:

```env
APP_ENV=local
APP_DEBUG=true
APP_KEY=your-secret-key
APP_URL=http://localhost:3000
APP_PORT=3000

DB_HOST=127.0.0.1
DB_PORT=5432
DB_USER=your_username
DB_PASSWORD=your_password
DB_DATABASE=my_blog_dev

SESSION_SECRET=your-session-secret

# Views
VIEW_CACHE=false
VIEW_DIRECTORY=resources/views
```

### Production Environment

For production deployment:

```env
APP_ENV=production
APP_DEBUG=false
APP_KEY=production-secret-key
APP_URL=https://your-domain.com
APP_PORT=3000

# Production database
DB_HOST=your-db-host
DB_PORT=5432
DB_USER=production_user
DB_PASSWORD=secure-password
DB_DATABASE=my_blog_prod

# Cache views in production
VIEW_CACHE=true
```

## Testing Your Application

### Running Tests

```bash
# Run all tests
bun test

# Run specific test file
bun test tests/user.test.ts

# Run tests with coverage
bun test --coverage
```

### Writing Tests

Create `tests/post.test.ts`:

```typescript
import { test, expect, beforeAll, afterAll } from 'bun:test'
import { PostFactory } from '../database/factories/post_factory.ts'

beforeAll(async () => {
  // Setup test database
})

afterAll(async () => {
  // Cleanup
})

test('should create post', async () => {
  const post = await PostFactory.create({
    title: 'Test Post',
    slug: 'test-post'
  })

  expect(post.title).toBe('Test Post')
  expect(post.slug).toBe('test-post')
})
```

## Deployment Checklist

### Pre-deployment

- [ ] Set `APP_ENV=production`
- [ ] Set `APP_DEBUG=false`
- [ ] Set `VIEW_CACHE=true`
- [ ] Configure production database
- [ ] Set secure `APP_KEY` and `SESSION_SECRET`
- [ ] Run `bun run typecheck`
- [ ] Run `bun test`

### Deployment Steps

```bash
# 1. Build application
bun install --production

# 2. Run migrations
bun strav migrate --scope=public

# 3. Build islands for production
bun strav build:islands

# 4. Start production server
bun start
```

## Troubleshooting

### Common Issues

**"Cannot find module '@strav/...'**
- Ensure you're in a Strav workspace
- Run `bun install` to install dependencies

**"Database connection failed"**
- Check PostgreSQL is running
- Verify credentials in `.env`
- Ensure database exists

**"Vue islands not loading"**
- Check `@islands` directive is in layout
- Verify `public/islands.js` exists
- Check browser console for errors

**"Schema changes not reflected"**
- Generate new migration: `bun strav generate:migration`
- Run migration: `bun strav migrate`
- Compare with: `bun strav compare`

### Getting Help

- Check the [full documentation](./spring.md)
- Review template examples
- Join the Strav community
- Check GitHub issues

## Next Steps

Now that you have a working Strav application:

1. **Explore the ecosystem** - Try other Strav packages
2. **Build real features** - Add authentication, file uploads, etc.
3. **Learn Vue islands** - Master progressive enhancement
4. **Deploy to production** - Try different hosting platforms
5. **Contribute back** - Share your experience with the community

Welcome to the Strav ecosystem! 🚀