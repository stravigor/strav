import { describe, test, expect, beforeEach } from 'bun:test'
import { router, route, routeUrl, routeFullUrl, Context } from '../src/http/index.ts'
import { app } from '@strav/kernel/core/application'
import Configuration from '@strav/kernel/config/configuration'

describe('Route Helper', () => {
  let server: ReturnType<typeof Bun.serve> | null = null

  beforeEach(() => {
    // Clear router for clean test environment
    router['routes'] = []

    // Register Configuration if not already registered
    if (!app.has(Configuration)) {
      app.singleton(Configuration)
    }
  })

  describe('URL Generation', () => {
    test('generates URLs for named routes', () => {
      router.get('/users', () => new Response('users')).as('users.index')
      router.get('/users/:id', () => new Response('user')).as('users.show')

      expect(routeUrl('users.index')).toBe('/users')
      expect(routeUrl('users.show', { id: 123 })).toBe('/users/123')
    })

    test('generates URLs with hierarchical group aliases', () => {
      router.group({ prefix: '/api' }, (r) => {
        r.group({ prefix: '/v1' }, (r) => {
          r.group({ prefix: '/users' }, (r) => {
            r.get('', () => new Response('users')).as('index')
            r.get('/:id', () => new Response('user')).as('show')
            r.post('', () => new Response('created')).as('create')
          }).as('users')
        }).as('v1')
      }).as('api')

      expect(routeUrl('api.v1.users.index')).toBe('/api/v1/users')
      expect(routeUrl('api.v1.users.show', { id: 456 })).toBe('/api/v1/users/456')
      expect(routeUrl('api.v1.users.create')).toBe('/api/v1/users')
    })

    test('adds extra parameters as query string', () => {
      router.get('/search/:category', () => new Response('results')).as('search')

      expect(routeUrl('search', { category: 'books', q: 'typescript', page: 2 }))
        .toBe('/search/books?q=typescript&page=2')
    })

    test('throws error for unknown route', () => {
      expect(() => routeUrl('nonexistent.route')).toThrow(`Route 'nonexistent.route' not found`)
    })

    test('throws error for missing required parameter', () => {
      router.get('/posts/:id', () => new Response('post')).as('posts.show')

      expect(() => routeUrl('posts.show')).toThrow(`Missing required parameter 'id' for route 'posts.show'`)
    })
  })

  describe('Route invocation', () => {
    test('detects method from route definition', async () => {
      // Start a test server
      const testRoutes: Array<{ method: string; path: string; body?: string }> = []

      router.post('/auth/register', (ctx) => {
        testRoutes.push({
          method: ctx.request.method,
          path: new URL(ctx.request.url).pathname,
          body: ctx.request.headers.get('content-type')
        })
        return new Response(JSON.stringify({ success: true }))
      }).as('auth.register')

      router.get('/users/:id', (ctx) => {
        testRoutes.push({
          method: ctx.request.method,
          path: new URL(ctx.request.url).pathname
        })
        return new Response(JSON.stringify({ id: ctx.params.id }))
      }).as('users.show')

      server = Bun.serve({
        port: 0, // Random port
        fetch: (req) => router.handle(req)
      })

      const port = server.port
      const baseUrl = `http://localhost:${port}`

      // Mock fetch to use our test server
      const originalFetch = globalThis.fetch
      globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? baseUrl + input : input
        return originalFetch(url, init)
      }

      try {
        // Test POST route
        const registerData = {
          name: 'John Doe',
          email: 'john@example.com',
          password: 'secret123'
        }

        const response1 = await route('auth.register', registerData)
        const result1 = await response1.json()

        expect(result1).toEqual({ success: true })
        expect(testRoutes[0].method).toBe('POST')
        expect(testRoutes[0].path).toBe('/auth/register')
        expect(testRoutes[0].body).toBe('application/json')

        // Test GET route with params
        const response2 = await route('users.show', { params: { id: 789 } })
        const result2 = await response2.json()

        expect(result2).toEqual({ id: '789' })
        expect(testRoutes[1].method).toBe('GET')
        expect(testRoutes[1].path).toBe('/users/789')
      } finally {
        globalThis.fetch = originalFetch
        server?.stop()
      }
    })

    test('handles different body types correctly', async () => {
      const bodies: Array<{ type: string; data: any }> = []

      router.post('/upload', async (ctx) => {
        const contentType = ctx.request.headers.get('content-type') || ''
        let data: any

        if (contentType.includes('multipart/form-data')) {
          data = 'FormData'
        } else if (contentType.includes('application/json')) {
          data = await ctx.request.json()
        } else {
          data = await ctx.request.text()
        }

        bodies.push({ type: contentType.split(';')[0], data })
        return new Response('ok')
      }).as('upload')

      server = Bun.serve({
        port: 0,
        fetch: (req) => router.handle(req)
      })

      const port = server.port
      const baseUrl = `http://localhost:${port}`

      const originalFetch = globalThis.fetch
      globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? baseUrl + input : input
        return originalFetch(url, init)
      }

      try {
        // JSON body (default)
        await route('upload', { test: 'json' })
        expect(bodies[0]).toEqual({
          type: 'application/json',
          data: { test: 'json' }
        })

        // FormData body
        const formData = new FormData()
        formData.append('file', 'test')
        await route('upload', formData)
        expect(bodies[1].type).toBe('multipart/form-data')

        // Plain text body
        await route('upload', {
          body: 'plain text',
          headers: { 'Content-Type': 'text/plain' }
        })
        expect(bodies[2]).toEqual({
          type: 'text/plain',
          data: 'plain text'
        })
      } finally {
        globalThis.fetch = originalFetch
        server?.stop()
      }
    })

    test('allows overriding default options', async () => {
      const capturedHeaders: Record<string, string> = {}

      router.get('/api/data', (ctx) => {
        ctx.request.headers.forEach((value, key) => {
          capturedHeaders[key] = value
        })
        return new Response('ok')
      }).as('api.data')

      server = Bun.serve({
        port: 0,
        fetch: (req) => router.handle(req)
      })

      const port = server.port
      const baseUrl = `http://localhost:${port}`

      const originalFetch = globalThis.fetch
      globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? baseUrl + input : input
        return originalFetch(url, init)
      }

      try {
        await route('api.data', {
          headers: {
            'Authorization': 'Bearer token123',
            'X-Custom-Header': 'custom-value'
          },
          cache: 'no-cache'
        })

        expect(capturedHeaders['authorization']).toBe('Bearer token123')
        expect(capturedHeaders['x-custom-header']).toBe('custom-value')
        expect(capturedHeaders['accept']).toBe('application/json')
      } finally {
        globalThis.fetch = originalFetch
        server?.stop()
      }
    })
  })

  describe('Full URL Generation', () => {
    test('generates full URLs with APP_URL config', () => {
      router.get('/users/:id', () => new Response('user')).as('users.show')
      router.get('/auth/reset', () => new Response('reset')).as('auth.reset')

      // Mock the config
      const config = app.resolve(Configuration)
      config.set('http.app_url', 'https://example.com')

      expect(routeFullUrl('users.show', { id: 123 })).toBe('https://example.com/users/123')
      expect(routeFullUrl('auth.reset', { token: 'abc123' })).toBe('https://example.com/auth/reset?token=abc123')

      // Clean up
      config.set('http.app_url', undefined)
    })

    test('generates full URLs from request context', () => {
      router.get('/api/data', () => new Response('data')).as('api.data')

      const mockRequest = new Request('http://api.example.com/test')
      const ctx = new Context(mockRequest)

      expect(routeFullUrl('api.data', { page: 2 }, ctx)).toBe('http://api.example.com/api/data?page=2')
    })

    test('handles X-Forwarded-Proto header', () => {
      router.get('/secure', () => new Response('secure')).as('secure.route')

      const headers = new Headers({
        'host': 'example.com',
        'x-forwarded-proto': 'https'
      })
      const mockRequest = new Request('http://example.com/test', { headers })
      const ctx = new Context(mockRequest)

      expect(routeFullUrl('secure.route', {}, ctx)).toBe('https://example.com/secure')
    })

    test('allows overriding base URL', () => {
      router.get('/api/v2/users', () => new Response('users')).as('api.v2.users')

      expect(routeFullUrl('api.v2.users', { limit: 10 }, null, 'https://api.myapp.com'))
        .toBe('https://api.myapp.com/api/v2/users?limit=10')
    })

    test('falls back to http config when no context or APP_URL', () => {
      router.get('/fallback', () => new Response('fallback')).as('fallback.route')

      const config = app.resolve(Configuration)
      config.set('http.domain', 'myapp.local')
      config.set('http.port', 8080)
      config.set('http.secure', false)
      config.set('http.app_url', undefined)

      expect(routeFullUrl('fallback.route')).toBe('http://myapp.local:8080/fallback')

      // Test with HTTPS and standard port
      config.set('http.secure', true)
      config.set('http.port', 443)
      expect(routeFullUrl('fallback.route')).toBe('https://myapp.local/fallback')

      // Clean up
      config.set('http.domain', 'localhost')
      config.set('http.port', 3000)
      config.set('http.secure', false)
    })

    test('strips trailing slash from base URL', () => {
      router.get('/path', () => new Response('path')).as('test.path')

      expect(routeFullUrl('test.path', {}, null, 'https://example.com/'))
        .toBe('https://example.com/path')

      const config = app.resolve(Configuration)
      config.set('http.app_url', 'https://myapp.com/')
      expect(routeFullUrl('test.path')).toBe('https://myapp.com/path')
      config.set('http.app_url', undefined)
    })
  })

  describe('Route lookup', () => {
    test('getRouteByName returns correct route definition', () => {
      router.post('/auth/login', () => new Response('ok')).as('auth.login')

      const route = router.getRouteByName('auth.login')
      expect(route).toBeDefined()
      expect(route?.method).toBe('POST')
      expect(route?.pattern).toBe('/auth/login')
      expect(route?.name).toBe('auth.login')
    })

    test('getRouteByName returns undefined for non-existent route', () => {
      const route = router.getRouteByName('non.existent')
      expect(route).toBeUndefined()
    })

    test('works with nested group aliases', () => {
      router.group({ prefix: '/api' }, (r) => {
        r.group({ prefix: '/admin' }, (r) => {
          r.delete('/users/:id', () => new Response('deleted')).as('deleteUser')
        }).as('admin')
      }).as('api')

      const route = router.getRouteByName('api.admin.deleteUser')
      expect(route).toBeDefined()
      expect(route?.method).toBe('DELETE')
      expect(route?.pattern).toBe('/api/admin/users/:id')
    })
  })
})