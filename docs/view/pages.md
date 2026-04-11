# Static Pages

Serve static `.strav` templates directly via clean URLs without explicit route definitions. Perfect for documentation sites, marketing pages, and simple content that doesn't require complex controller logic.

## Quick start

```typescript
// 1. Enable static pages in config/view.ts
export default {
  directory: 'resources/views',
  cache: env.bool('VIEW_CACHE', true),
  assets: ['css/app.css', 'builds/islands.js'],
  pages: {
    directory: 'pages',
    enabled: true,
    indexFile: 'index.strav'
  }
}

// 2. Register PagesProvider in start/providers.ts
import { ViewProvider, PagesProvider } from '@strav/view'

export const providers = [
  new ViewProvider(),
  new PagesProvider(),  // Must come after ViewProvider
]
```

```html
<!-- 3. Create pages/about.strav -->
@layout('layouts/app')

@section('content')
  <h1>About Us</h1>
  <p>This page is automatically served at /about</p>
  <vue:contact-form />
@end
```

Now visit `/about` in your browser to see the rendered page with full Vue islands support.

## Setup

Add both `ViewProvider` and `PagesProvider` to `start/providers.ts`:

```typescript
import { ViewProvider, PagesProvider } from '@strav/view'

export const providers = [
  // ... other providers
  new ViewProvider(),
  new PagesProvider(),
]
```

The `PagesProvider` depends on `ViewProvider` and must be registered after it.

## Configuration

Configure static pages in `config/view.ts`:

```typescript
import { env } from '@strav/kernel'

export default {
  directory: 'resources/views',
  cache: env.bool('VIEW_CACHE', true),
  assets: ['css/app.css', 'builds/islands.js'],
  pages: {
    directory: 'pages',           // Directory relative to resources/views
    enabled: true,                // Enable/disable static pages
    indexFile: 'index.strav'      // Default file for directory requests
  }
}
```

### Configuration options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `directory` | `string` | `'pages'` | Directory containing page files, relative to view directory |
| `enabled` | `boolean` | `true` | Whether static pages are enabled |
| `indexFile` | `string` | `'index.strav'` | Default file to serve for directory requests |

## URL mapping

Static pages follow a simple file-to-URL mapping:

```
resources/views/pages/
├── index.strav          → /
├── about.strav          → /about
├── contact.strav        → /contact
├── docs/
│   ├── index.strav      → /docs or /docs/
│   ├── getting-started.strav → /docs/getting-started
│   └── api/
│       └── reference.strav   → /docs/api/reference
└── blog/
    ├── index.strav      → /blog
    └── 2024-recap.strav → /blog/2024-recap
```

### URL resolution rules

1. **Root path** (`/`) → `pages/index.strav`
2. **Direct file** (`/about`) → `pages/about.strav`
3. **Directory with slash** (`/docs/`) → `pages/docs/index.strav`
4. **Directory without slash** (`/docs`) → tries `pages/docs.strav` first, then `pages/docs/index.strav`
5. **Nested paths** (`/docs/getting-started`) → `pages/docs/getting-started.strav`

## Template features

Static pages support all `.strav` template features:

### Layout inheritance

```html
<!-- pages/about.strav -->
@layout('layouts/app')

@section('title', 'About Us')

@section('content')
  <h1>About Our Company</h1>
  <p>Founded in 2024...</p>
@end
```

### Vue islands

```html
<!-- pages/contact.strav -->
@layout('layouts/app')

@section('content')
  <h1>Contact Us</h1>
  <vue:contact-form :user="{{ auth.user() }}" />

  <div class="map">
    <vue:interactive-map location="San Francisco" />
  </div>
@end
```

### Template directives

```html
<!-- pages/features.strav -->
@layout('layouts/app')

@section('content')
  <h1>Features</h1>

  @if(features.length > 0)
    <div class="feature-grid">
      @each feature in features
        <div class="feature-card">
          <h3>{{ feature.title }}</h3>
          <p>{{ feature.description }}</p>
        </div>
      @end
    </div>
  @else
    <p>No features available.</p>
  @end
@end
```

### Asset inclusion

```html
<!-- pages/dashboard.strav -->
@layout('layouts/app')

@section('head')
  @push('styles')
    <link rel="stylesheet" href="{{ asset('css/dashboard.css') }}">
  @end
@end

@section('content')
  <h1>Dashboard</h1>
  <vue:analytics-chart />
@end
```

## Data passing

Since static pages don't use controllers, they can't receive dynamic data directly. However, you can:

### Use global view helpers

```typescript
// In a service provider
ViewEngine.setGlobal('currentYear', new Date().getFullYear())
ViewEngine.setGlobal('siteName', 'My Awesome Site')
```

```html
<!-- Any page can now use -->
<footer>
  &copy; {{ currentYear }} {{ siteName }}
</footer>
```

### Pass data via Vue islands

```html
<!-- pages/pricing.strav -->
@layout('layouts/app')

@section('content')
  <h1>Pricing</h1>
  <vue:pricing-table
    :plans="{{ JSON.stringify(plans) }}"
    currency="USD"
  />
@end
```

The Vue component receives the data and handles any dynamic behavior.

## Security

Static pages include built-in security protections:

- **Path traversal prevention**: URLs like `/../../etc/passwd` are blocked
- **File extension validation**: Only `.strav` files are served
- **Directory bounds**: File resolution is restricted to the pages directory

## File organization

Organize your pages logically:

```
resources/views/pages/
├── index.strav                    # Homepage
├── about.strav                    # About page
├── contact.strav                  # Contact page
├── legal/
│   ├── index.strav               # Legal hub page
│   ├── privacy.strav             # Privacy policy
│   └── terms.strav               # Terms of service
├── docs/
│   ├── index.strav               # Documentation home
│   ├── getting-started.strav     # Getting started guide
│   ├── api/
│   │   ├── index.strav          # API documentation home
│   │   ├── authentication.strav  # Auth docs
│   │   └── endpoints.strav       # Endpoint docs
│   └── examples/
│       ├── index.strav          # Examples home
│       └── basic-usage.strav     # Basic usage example
└── blog/
    ├── index.strav               # Blog listing
    ├── 2024-year-in-review.strav # Blog post
    └── welcome-to-strav.strav    # Blog post
```

## Performance

Static pages benefit from all existing Strav view optimizations:

- **Template caching**: Compiled templates are cached for fast re-renders
- **Asset versioning**: Automatic cache-busting for CSS/JS assets
- **Vue islands**: Only interactive components are hydrated client-side
- **File watching**: Templates auto-reload in development

## Route precedence

Static pages use catch-all routes registered **after** all application routes, so:

1. Explicit application routes take precedence
2. Static pages serve as fallbacks
3. 404 responses for missing static pages

Example:

```typescript
// This explicit route takes precedence over pages/api.strav
router.get('/api', (ctx) => ctx.json({ message: 'API endpoint' }))

// Only if no /api route exists will pages/api.strav be served
```

## Common patterns

### Documentation site

```
pages/
├── index.strav              # Landing page
├── docs/
│   ├── index.strav          # Docs home with navigation
│   ├── installation.strav   # Installation guide
│   ├── configuration.strav  # Configuration guide
│   └── api-reference.strav  # API reference
└── examples/
    ├── index.strav          # Examples home
    ├── basic.strav          # Basic example
    └── advanced.strav       # Advanced example
```

### Marketing site

```
pages/
├── index.strav              # Homepage
├── features.strav           # Feature overview
├── pricing.strav            # Pricing plans
├── about.strav              # About the company
├── contact.strav            # Contact form
└── legal/
    ├── privacy.strav        # Privacy policy
    └── terms.strav          # Terms of service
```

### Blog

```
pages/
├── blog/
│   ├── index.strav                    # Blog listing
│   ├── getting-started-with-strav.strav
│   ├── vue-islands-explained.strav
│   └── building-apis-in-2024.strav
└── authors/
    ├── john-doe.strav               # Author profile
    └── jane-smith.strav             # Author profile
```

## Limitations

- **No dynamic data**: Pages can't receive controller-injected data
- **No middleware**: Pages bypass route middleware (use global middleware instead)
- **No validation**: No built-in form validation (handle in Vue islands)
- **Static only**: Best for content that doesn't change frequently

For dynamic content, use traditional routes with controllers instead of static pages.