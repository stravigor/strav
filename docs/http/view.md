# View Engine

Server-side template engine with Vue.js island support. Renders `.strav` templates to HTML strings, compiles them to cached async functions for fast repeated renders.

## Quick start

```typescript
import { ViewEngine, view } from '@strav/view'

// In a route handler via Context
router.get('/users', async (ctx) => {
  const users = await User.all()
  return ctx.view('pages/users', { users, title: 'Users' })
})

// Or with the standalone helper
router.get('/', async () => {
  return view('pages/home', { title: 'Welcome' })
})
```

## Setup

Register the `ViewProvider` in your application:

```typescript
import { ViewProvider } from '@strav/view'

app.use(new ViewProvider())
```

This registers the `ViewEngine` singleton and wires it into the HTTP context so `ctx.view()` works in all route handlers.

Templates live in the `views/` directory by default. Configure via `config/view.ts`:

```typescript
import { env } from '@strav/kernel'

export default {
  directory: env('VIEW_DIRECTORY', 'views'),
  cache: env.bool('VIEW_CACHE', true),   // disable in development for auto-reload
}
```

## Template syntax

### Expressions

```html
{{ user.name }}           {{-- escaped output (HTML entities) --}}
{!! user.bio !!}          {{-- raw output (no escaping) --}}
{{-- this is a comment, stripped from output --}}
```

Expressions are real JavaScript — `{{ items.length + 1 }}`, `{{ user.name.toUpperCase() }}`, and ternaries all work.

### Conditionals

```html
@if(user.isAdmin)
  <span class="badge">Admin</span>
@elseif(user.isMod)
  <span class="badge">Moderator</span>
@else
  <span class="badge">Member</span>
@end
```

Any JS expression works as the condition: `@if(items.length > 0)`, `@if(user && user.verified)`.

### Loops

```html
<ul>
  @each(item in items)
    <li>{{ item.name }}</li>
  @end
</ul>
```

Inside loops, these variables are available automatically:

| Variable | Type | Description |
|----------|------|-------------|
| `$index` | `number` | Current iteration index (0-based) |
| `$first` | `boolean` | `true` on the first iteration |
| `$last` | `boolean` | `true` on the last iteration |

```html
@each(user in users)
  <div class="{{ $first ? 'border-t' : '' }}">
    {{ $index + 1 }}. {{ user.name }}
  </div>
@end
```

### Includes

Render a partial template with its own data:

```html
@include('partials/nav', { user, notifications })
```

The included template receives both the parent data and any additional data passed. Template names use `/` as separators, mapping to file paths inside the views directory.

### Layouts and blocks

Layouts define the page shell. Child templates fill named blocks.

```html
{{-- views/layouts/app.strav --}}
<!DOCTYPE html>
<html>
<head><title>{{ title }}</title></head>
<body>
  @include('partials/nav', { user })
  <main>
    @if(content)
      {!! content !!}
    @else
      <p>No content</p>
    @end
  </main>
</body>
</html>
```

```html
{{-- views/pages/dashboard.strav --}}
@layout('layouts/app')

@block('content')
  <h1>Dashboard</h1>
  <p>Welcome back, {{ user.name }}</p>
@end
```

The child template renders first, collecting its blocks. Then the layout renders with those blocks available as data.

## Vue islands

For interactive components, use Vue islands. The server renders a placeholder `<div>` and Vue hydrates it on the client.

### In templates

```html
<vue:search-bar placeholder="Search users..." />
<vue:counter :initial="{{ startCount }}" label="Click me" />
```

Static attributes pass string values. Bound attributes (`:prop`) evaluate the expression at render time. The server output:

```html
<div data-vue="search-bar" data-props='{"placeholder":"Search users..."}'></div>
<div data-vue="counter" data-props='{"initial":5,"label":"Click me"}'></div>
```

### Vue SFC islands (recommended)

Write real `.vue` single-file components in an `islands/` directory. The framework compiles and bundles them automatically.

**1. Create `.vue` files:**

```vue
<!-- islands/counter.vue -->
<template>
  <div class="counter">
    <button @click="count--">-</button>
    <span>{{ count }}</span>
    <button @click="count++">+</button>
  </div>
</template>

<script setup>
import { ref } from 'vue'

const props = defineProps({ initial: { type: Number, default: 0 } })
const count = ref(props.initial)
</script>

<style scoped>
.counter { display: flex; gap: 8px; align-items: center; }
</style>
```

Both `<script setup>` and Options API (`<script>`) are supported. `<style scoped>` works as expected.

**2. Use `@islands` in your template:**

```html
{{-- views/pages/home.strav --}}
@layout('layouts/app')

@block('content')
  <h1>Welcome</h1>
  <vue:counter :initial="{{ startCount }}" />
@end

@block('scripts')
  @islands
@end
```

The `@islands` directive emits `<script src="/islands.js"></script>`. You can pass a custom path: `@islands('/assets/islands.js')`.

**3. Build islands before server start:**

```typescript
import { IslandBuilder } from '@strav/view'

const islands = new IslandBuilder()
await islands.build()

// Then start the server (scanPublicDir picks up the built islands.js)
server.start(router)
```

`IslandBuilder.build()` scans the `islands/` directory, compiles all `.vue` files using `@vue/compiler-sfc`, and bundles everything (Vue runtime + components + mount logic) into a single `public/islands.js`.

**Options:**

```typescript
const islands = new IslandBuilder({
  islandsDir: './islands',    // default: './islands'
  outDir: './public',         // default: './public'
  outFile: 'islands.js',     // default: 'islands.js'
  minify: true,               // default: true in production
})
```

**Dev mode — watch for changes:**

```typescript
// Rebuild islands.js automatically when .vue files change
islands.watch()

// Stop watching
islands.unwatch()
```

**Dependencies:** The app package needs `vue` as a dependency (it gets bundled into `islands.js`):

```json
{
  "dependencies": {
    "vue": "^3.5.28"
  }
}
```

### Manual bootstrap (alternative)

For apps that load Vue from a CDN or need custom control, you can manually register components on `window.__vue_components` and use the client-side islands bootstrap:

```typescript
import SearchBar from './components/SearchBar.vue'
import Counter from './components/Counter.vue'

;(window as any).__vue_components = {
  'search-bar': SearchBar,
  'counter': Counter,
}

import '@strav/view/client/islands'
```

Include the bundled script in your layout:

```html
<script type="module" src="/assets/app.js"></script>
```

## Static file middleware

Serve files from a `public/` directory:

```typescript
import { staticFiles } from '@strav/view'

router.use(staticFiles('public'))
```

Serves any file that exists under the root directory. Falls through to the next middleware when no file matches. Blocks directory traversal and hidden files automatically.

## Template resolution

Template names map to file paths:

| Name | File path |
|------|-----------|
| `'pages/home'` | `views/pages/home.strav` |
| `'layouts/app'` | `views/layouts/app.strav` |
| `'partials/nav'` | `views/partials/nav.strav` |

## Caching

In production (`VIEW_CACHE=true`), templates are compiled once and cached in memory for the lifetime of the process — subsequent renders skip file I/O and parsing entirely.

In development (`VIEW_CACHE=false`), the engine checks file modification times before each render and recompiles automatically when the source changes.

## Testing

Test templates directly with the engine:

```typescript
import { test, expect, beforeAll } from 'bun:test'
import ViewEngine from '@strav/view'
import Configuration from '@strav/kernel'

let engine: ViewEngine

beforeAll(async () => {
  const config = new Configuration('config')
  config.set('view.directory', 'tests/view/fixtures')
  config.set('view.cache', false)
  engine = new ViewEngine(config)
})

test('renders user page', async () => {
  const html = await engine.render('pages/users', {
    users: [{ name: 'Alice' }],
    title: 'Users',
  })
  expect(html).toContain('Alice')
})
```
