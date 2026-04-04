/**
 * Example usage of the route helper with the new group alias naming system.
 *
 * This file demonstrates how to use the `route()` and `routeUrl()` helpers
 * to invoke named routes transparently without hardcoding URLs.
 */

import { router, route, routeUrl } from '@strav/http'

// ============================================================================
// 1. Setting up routes with hierarchical group aliases
// ============================================================================

// API routes with versioning
router.group({ prefix: '/api' }, (r) => {
  r.group({ prefix: '/v1' }, (r) => {
    // Authentication endpoints
    r.group({ prefix: '/auth' }, (r) => {
      r.post('/register', async (ctx) => {
        const data = await ctx.request.json()
        // Handle registration...
        return ctx.json({ success: true, user_id: 123 })
      }).as('register')

      r.post('/login', async (ctx) => {
        const data = await ctx.request.json()
        // Handle login...
        return ctx.json({ token: 'jwt_token_here' })
      }).as('login')

      r.post('/logout', (ctx) => {
        // Handle logout...
        return ctx.json({ success: true })
      }).as('logout')
    }).as('auth')

    // User management
    r.group({ prefix: '/users' }, (r) => {
      r.get('', (ctx) => {
        // Get all users
        return ctx.json({ users: [] })
      }).as('index')

      r.get('/:id', (ctx) => {
        // Get specific user
        return ctx.json({ id: ctx.params.id, name: 'John Doe' })
      }).as('show')

      r.put('/:id', async (ctx) => {
        const data = await ctx.request.json()
        // Update user
        return ctx.json({ success: true })
      }).as('update')

      r.delete('/:id', (ctx) => {
        // Delete user
        return ctx.json({ success: true })
      }).as('delete')
    }).as('users')

    // File uploads
    r.post('/upload', async (ctx) => {
      const formData = await ctx.request.formData()
      // Handle file upload
      return ctx.json({ file_id: 'abc123' })
    }).as('upload')
  }).as('v1')
}).as('api')

// Public routes
router.group({ prefix: '' }, (r) => {
  r.get('/', (ctx) => {
    return new Response('Welcome!')
  }).as('home')

  r.get('/about', (ctx) => {
    return new Response('About page')
  }).as('about')
}).as('public')

// ============================================================================
// 2. Using the route() helper to invoke routes
// ============================================================================

// Example 1: Simple POST with JSON body (auto-detected)
async function registerUser() {
  const response = await route('api.v1.auth.register', {
    name: 'Jane Smith',
    email: 'jane@example.com',
    password: 'secure_password',
    terms_accepted: true
  })
  const result = await response.json()
  console.log('Registration result:', result)
}

// Example 2: GET request with URL parameters
async function getUser(userId: number) {
  const response = await route('api.v1.users.show', {
    params: { id: userId }
  })
  const user = await response.json()
  console.log('User data:', user)
}

// Example 3: PUT request with parameters and body
async function updateUser(userId: number, updates: object) {
  const response = await route('api.v1.users.update', {
    params: { id: userId },
    body: updates
  })
  const result = await response.json()
  console.log('Update result:', result)
}

// Example 4: File upload with FormData
async function uploadFile(file: File) {
  const formData = new FormData()
  formData.append('file', file)
  formData.append('description', 'Profile picture')

  const response = await route('api.v1.upload', formData)
  const result = await response.json()
  console.log('Upload result:', result)
}

// Example 5: Custom headers and options
async function authenticatedRequest() {
  const response = await route('api.v1.users.index', {
    headers: {
      'Authorization': 'Bearer jwt_token_here',
      'X-Custom-Header': 'custom-value'
    },
    cache: 'no-cache',
    credentials: 'include'
  })
  const users = await response.json()
  console.log('Users:', users)
}

// Example 6: Query parameters (not part of route pattern)
async function searchUsers(query: string, page: number) {
  const response = await route('api.v1.users.index', {
    params: {
      q: query,  // Will be added as ?q=...
      page: page // Will be added as &page=...
    }
  })
  const results = await response.json()
  console.log('Search results:', results)
}

// ============================================================================
// 3. Using the routeUrl() helper to generate URLs
// ============================================================================

// Generate URLs for use in templates, redirects, etc.
const urls = {
  home: routeUrl('public.home'),                               // '/'
  about: routeUrl('public.about'),                             // '/about'
  register: routeUrl('api.v1.auth.register'),                  // '/api/v1/auth/register'
  userProfile: routeUrl('api.v1.users.show', { id: 123 }),     // '/api/v1/users/123'
  userSearch: routeUrl('api.v1.users.index', {                 // '/api/v1/users?q=john&page=2'
    q: 'john',
    page: 2
  })
}

console.log('Generated URLs:', urls)

// ============================================================================
// 4. Error handling
// ============================================================================

async function handleErrors() {
  try {
    // This will throw an error if the route doesn't exist
    await route('non.existent.route', {})
  } catch (error) {
    console.error('Route not found:', error.message)
  }

  try {
    // This will throw an error if required parameters are missing
    routeUrl('api.v1.users.show')
  } catch (error) {
    console.error('Missing parameter:', error.message)
  }
}

// ============================================================================
// 5. Benefits of this approach
// ============================================================================

/**
 * Benefits of using route() and routeUrl() helpers:
 *
 * 1. **No hardcoded URLs**: All URLs are generated from route definitions
 * 2. **Type safety**: Routes are checked at runtime (can add TypeScript types)
 * 3. **Automatic method detection**: No need to specify GET/POST/PUT/DELETE
 * 4. **Smart defaults**: Automatically sets Accept and Content-Type headers
 * 5. **Centralized routing**: Changes to routes only need to be made in one place
 * 6. **Clean API**: Simple, intuitive syntax for making requests
 * 7. **Consistent**: Same approach for all HTTP methods and content types
 * 8. **Refactoring-friendly**: Rename routes without breaking client code
 * 9. **Self-documenting**: Route names describe their purpose
 * 10. **Framework integration**: Works seamlessly with the router's group aliases
 */

// Export example functions for testing
export {
  registerUser,
  getUser,
  updateUser,
  uploadFile,
  authenticatedRequest,
  searchUsers,
  handleErrors
}