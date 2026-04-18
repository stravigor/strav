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

Add the `ViewProvider` to `start/providers.ts`:

```typescript
import { ViewProvider } from '@strav/view'

new ViewProvider(),
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

### Conditional classes

Build a `class` attribute with conditional entries. Plain strings are always included; entries with `=>` are included only when the condition is truthy.

```html
<span @class([
    'p-4',
    'font-bold' => isActive,
    'text-gray-500' => !isActive,
    'bg-red' => hasError,
])></span>
```

When `isActive` is `true` and `hasError` is `false`, this renders:

```html
<span class="p-4 font-bold"></span>
```

### Conditional styles

Works the same as `@class` but outputs a `style` attribute, joining entries with `; `.

```html
<span @style([
    'background-color: red',
    'font-weight: bold' => isActive,
])></span>
```

When `isActive` is `true`:

```html
<span style="background-color: red; font-weight: bold"></span>
```

### CSS

Include CSS files built with IslandBuilder:

```html
{{-- Include all CSS files --}}
@css

{{-- Include specific named CSS file --}}
@css('admin')
```

When using multiple CSS entries with IslandBuilder, `@css` outputs `<link>` tags for all configured CSS files. Use `@css('key')` to include a specific CSS file. The directive automatically includes versioned URLs for cache busting.

### CSRF

Output a hidden CSRF token input inside forms:

```html
<form method="POST" action="/submit">
  @csrf
  <input type="text" name="title">
  <button type="submit">Save</button>
</form>
```

Renders: `<input type="hidden" name="_token" value="a1b2c3...">`. The token is automatically available when the `session()` middleware is active — no need to pass it from the controller.

Pair with the `csrf()` middleware on the route group to validate incoming tokens on POST/PUT/PATCH/DELETE (see [auth docs](../../http/docs/auth.md#csrf--csrf-protection)).

### Content stacks

Stack-based content sections for collecting and outputting content from multiple locations, useful for assets like scripts and styles.

**@push** — Add content to the end of a stack:

```html
@push('scripts')
  <script src="app.js"></script>
@end

@push('scripts')
  <script>console.log('ready')</script>
@end
```

**@prepend** — Add content to the beginning of a stack:

```html
@prepend('scripts')
  <script>window.config = {}</script>
@end
```

**@stack** — Output all content from a stack:

```html
<html>
<head>
  @stack('styles')
</head>
<body>
  @stack('scripts')
</body>
</html>
```

Common pattern for layouts:

```html
{{-- views/layouts/app.strav --}}
<!DOCTYPE html>
<html>
<head>
  <title>{{ title }}</title>
  @stack('styles')
</head>
<body>
  @show('content')
  @stack('scripts')
</body>
</html>
```

```html
{{-- views/pages/dashboard.strav --}}
@layout('layouts/app')

@push('styles')
  <link rel="stylesheet" href="dashboard.css">
@end

@prepend('scripts')
  <script>window.dashboard = true</script>
@end

@section('content')
  <h1>Dashboard</h1>
@end
```

Stacks accumulate content across template includes and layout inheritance. `@prepend` content appears before `@push` content in the output order.

### Includes

Render a partial template with its own data:

```html
@include('partials/nav', { user, notifications })
```

The included template receives both the parent data and any additional data passed. Template names use `/` as separators, mapping to file paths inside the views directory.

### Layouts and sections

Layouts define the page shell. Child templates fill named sections.

**Layout** — use `@show('name')` to mark where child content goes:

```html
{{-- views/layouts/app.strav --}}
<!DOCTYPE html>
<html>
<head><title>{{ title }}</title></head>
<body>
  @include('partials/nav', { user })
  <main>
    @show('content')
  </main>
</body>
</html>
```

**Child template** — use `@section('name')...@end` to provide content:

```html
{{-- views/pages/dashboard.strav --}}
@layout('layouts/app')

@section('content')
  <h1>Dashboard</h1>
  <p>Welcome back, {{ user.name }}</p>
@end
```

The child template renders first, collecting its sections. Then the layout renders with those sections available as data.

### Setting layout variables

Use `@set` to declare variables in child templates that parent layouts can access:

```html
{{-- views/pages/about.strav --}}
@layout('layouts/app')
@set('title', 'About Us')
@set('meta_description', 'Learn more about our company')

@section('content')
  <h1>About Us</h1>
  <p>Welcome to our company...</p>
@end
```

**Layout** — variables are automatically available:

```html
{{-- views/layouts/app.strav --}}
<!DOCTYPE html>
<html>
<head>
  <title>{{ title }}</title>
  <meta name="description" content="{{ meta_description }}">
</head>
<body>
  @show('content')
</body>
</html>
```

Variables set with `@set` are merged into the parent layout's template data, making them accessible via normal `{{ variable }}` expressions. This provides a clean separation between content blocks (`@section`) and simple key-value data (`@set`).

### Asset versioning

Append content hashes to asset URLs for cache busting. List assets in `config/view.ts` and the `ViewProvider` handles the rest — hashing at boot, registering the `asset()` template global, and watching for changes in development.

**Config:**

```typescript
// config/view.ts
export default {
  directory: 'resources/views',
  cache: env.bool('VIEW_CACHE', true),
  assets: ['/css/app.css'],
}
```

**In templates:**

```html
<link rel="stylesheet" href="{{ asset('/css/app.css') }}">
```

Renders: `<link rel="stylesheet" href="/css/app.css?v=a1b2c3d4">`

The hash changes when the file content changes. In development, file watchers automatically re-hash when assets are rebuilt. You can version any file in the public directory — CSS, JS, images, fonts.

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

@section('content')
  <h1>Welcome</h1>
  <vue:counter :initial="{{ startCount }}" />
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
  css: {                      // optional: CSS compilation
    entry: 'resources/css/app.scss',   // see below for multiple entries
    outDir: './public/css',             // default: './public/css'
    basePath: '/css/',                  // default: '/css/'
  }
})
```

**Multiple CSS entries:**

The `css.entry` option supports three formats:

```typescript
// Single entry (backward compatible)
css: { entry: 'resources/css/app.scss' }

// Array of entries (auto-generated output names)
css: {
  entry: [
    'resources/css/app.scss',      // → app.css
    'resources/css/admin.scss',    // → admin.css
    'resources/css/vendor.scss'    // → vendor.css
  ]
}

// Named entries (explicit keys)
css: {
  entry: {
    main: 'resources/css/app.scss',     // → main.css
    admin: 'resources/css/admin.scss',  // → admin.css
    vendor: 'resources/css/vendor.scss' // → vendor.css
  }
}
```

**Dev mode — watch for changes:**

```typescript
// Rebuild islands.js automatically when .vue files change
islands.watch()

// Stop watching
islands.unwatch()
```

**Complete example with multiple CSS:**

```typescript
// server.ts
import { IslandBuilder } from '@strav/view'

const islands = new IslandBuilder({
  css: {
    entry: {
      main: 'resources/css/app.scss',
      admin: 'resources/css/admin.scss',
      critical: 'resources/css/critical.scss'
    }
  }
})

await islands.build()

if (Bun.env.NODE_ENV !== 'production') {
  islands.watch()
}
```

```html
{{-- views/layouts/app.strav --}}
<!DOCTYPE html>
<html>
<head>
  <title>{{ title }}</title>
  @css('critical')  {{-- Critical CSS only --}}
</head>
<body>
  @show('content')

  @css  {{-- All CSS files --}}
  @islands
</body>
</html>
```

```html
{{-- views/admin/dashboard.strav --}}
@layout('layouts/admin')

@section('head')
  @css('admin')  {{-- Admin-specific CSS --}}
@end
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

## SPA routing

For single-page applications built with Vue islands, the framework provides a shared routing system. Route definitions are declared once and used by both the server (to register GET handlers) and the client (to match URLs and render views).

### Defining routes

Create a shared route file that both server and client import:

```typescript
// routes/spa.ts
import { defineRoutes } from '@strav/view'

export default defineRoutes([
  { path: '/', name: 'dashboard', view: 'Dashboard' },
  { path: '/settings', name: 'settings', view: 'Settings' },
  { path: '/projects/:id', name: 'project', view: 'ProjectDashboard',
    props: (p) => ({ projectId: Number(p.id) }) },
  { path: '/projects/:id/chat', name: 'chat', view: 'Chat',
    props: (p) => ({ projectId: Number(p.id) }) },
])
```

Each route has a `path` (with `:param` segments), a `name` for programmatic navigation, and a `view` string that maps to a Vue component. The optional `props` function converts URL params into component props.

### Server-side registration

Use `spaRoutes()` to register all routes as GET handlers pointing to a single controller action (which renders the shell template):

```typescript
// start/routes.ts
import { spaRoutes } from '@strav/view'
import spaRouteDefs from '../routes/spa.ts'

export default (router: Router) => {
  spaRoutes(router, spaRouteDefs, [AppController, 'index'])
}
```

This replaces manual `router.get()` calls for each SPA route. The controller renders the base template with the Vue island that hosts the SPA shell.

### Client-side router

The client-side router is a Vue plugin that provides reactive route matching, programmatic navigation, and `RouterView`/`RouterLink` components.

**Initialize in setup.ts:**

```typescript
// islands/setup.ts
import type { App } from 'vue'
import { createRouter } from '@strav/view/client/router'
import spaRouteDefs from '../../routes/spa.ts'
import Dashboard from './views/Dashboard.vue'
import Chat from './views/Chat.vue'
import NotFound from './views/NotFound.vue'

export default (app: App) => {
  app.use(createRouter({
    routes: spaRouteDefs,
    views: { Dashboard, Chat },
    fallback: NotFound,
  }))
}
```

The `views` object maps view names (from route definitions) to Vue components. The optional `fallback` component renders for unmatched URLs.

**Use in the shell component:**

```vue
<!-- islands/app.vue -->
<template>
  <aside><!-- sidebar --></aside>
  <main>
    <RouterView />
  </main>
</template>
```

`RouterView` renders the matched component with resolved props automatically.

### Composables

**`useRouter()`** — returns the router instance for programmatic navigation:

```typescript
import { useRouter } from '@strav/view/client/router'

const router = useRouter()

// Navigate by path
router.push('/projects/1/chat')

// Navigate by name
router.push({ name: 'chat', params: { id: '1' } })

// Replace (no history entry)
router.replace('/settings')

// History navigation
router.back()
router.forward()
```

**`useRoute()`** — returns a reactive ref of the current route:

```typescript
import { useRoute } from '@strav/view/client/router'

const route = useRoute()

// Access reactive route data
route.value.path    // '/projects/1/chat'
route.value.name    // 'chat'
route.value.params  // { id: '1' }
route.value.view    // 'Chat'
```

### RouterLink

`RouterLink` renders an `<a>` tag with client-side navigation. It respects modifier keys (Cmd/Ctrl+click opens in a new tab).

```vue
<RouterLink to="/settings" v-slot="{ isActive }">
  <span :class="isActive ? 'text-white' : 'text-gray-500'">Settings</span>
</RouterLink>
```

The scoped slot exposes `{ href, isActive, isExactActive, navigate }`.

`isActive` is `true` when the current path starts with the link's href (prefix match). `isExactActive` is `true` only on exact match.

## Static file middleware

Serve files from a `public/` directory:

```typescript
import { staticFiles } from '@strav/http'

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

### Watching for changes

Call `watch()` to clear the cache automatically when `.strav` files change — no server restart needed:

```typescript
if (Bun.env.NODE_ENV !== 'production') {
  ViewEngine.instance.watch()
}
```

This uses `fs.watch()` recursively on the views directory. When a `.strav` file is modified, the entire cache is cleared and the next request recompiles the template from disk. Call `unwatch()` to stop.

## Testing

Test templates directly with the engine:

```typescript
import { test, expect, beforeAll } from 'bun:test'
import { ViewEngine } from '@strav/view'
import { Configuration } from '@strav/kernel'

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
