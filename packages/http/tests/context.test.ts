import { describe, test, expect } from 'bun:test'
import { Context } from '../src/http/index.ts'

describe('Context', () => {
  describe('getOrigin', () => {
    test('returns origin from request URL', () => {
      const request = new Request('http://example.com/test')
      const ctx = new Context(request)

      expect(ctx.getOrigin()).toBe('http://example.com')
    })

    test('uses host header if present', () => {
      const headers = new Headers({
        'host': 'api.example.com:8080'
      })
      const request = new Request('http://localhost/test', { headers })
      const ctx = new Context(request)

      expect(ctx.getOrigin()).toBe('http://api.example.com:8080')
    })

    test('respects X-Forwarded-Proto header', () => {
      const headers = new Headers({
        'host': 'example.com',
        'x-forwarded-proto': 'https'
      })
      const request = new Request('http://example.com/test', { headers })
      const ctx = new Context(request)

      expect(ctx.getOrigin()).toBe('https://example.com')
    })

    test('handles https protocol', () => {
      const request = new Request('https://secure.example.com/test')
      const ctx = new Context(request)

      expect(ctx.getOrigin()).toBe('https://secure.example.com')
    })

    test('includes non-standard ports', () => {
      const request = new Request('http://example.com:3000/test')
      const ctx = new Context(request)

      expect(ctx.getOrigin()).toBe('http://example.com:3000')
    })

    test('handles standard ports correctly', () => {
      // Bun's Request normalizes URLs by removing standard ports
      const request1 = new Request('http://example.com:80/test')
      const ctx1 = new Context(request1)
      expect(ctx1.getOrigin()).toBe('http://example.com')

      const request2 = new Request('https://example.com:443/test')
      const ctx2 = new Context(request2)
      expect(ctx2.getOrigin()).toBe('https://example.com')
    })
  })

  describe('subdomain extraction', () => {
    test('extracts subdomain from host header', () => {
      const headers = new Headers({
        'host': 'api.example.com'
      })
      const request = new Request('http://api.example.com/test', { headers })
      const ctx = new Context(request, {}, 'example.com')

      expect(ctx.subdomain).toBe('api')
    })

    test('handles multiple subdomain levels', () => {
      const headers = new Headers({
        'host': 'v2.api.example.com'
      })
      const request = new Request('http://v2.api.example.com/test', { headers })
      const ctx = new Context(request, {}, 'example.com')

      expect(ctx.subdomain).toBe('v2.api')
    })

    test('returns empty string when no subdomain', () => {
      const headers = new Headers({
        'host': 'example.com'
      })
      const request = new Request('http://example.com/test', { headers })
      const ctx = new Context(request, {}, 'example.com')

      expect(ctx.subdomain).toBe('')
    })

    test('handles port in host header', () => {
      const headers = new Headers({
        'host': 'api.example.com:3000'
      })
      const request = new Request('http://api.example.com:3000/test', { headers })
      const ctx = new Context(request, {}, 'example.com')

      expect(ctx.subdomain).toBe('api')
    })
  })

  describe('inputs', () => {
    test('reads urlencoded fields by name', async () => {
      const body = new URLSearchParams({ name: 'alice', email: 'a@x' })
      const request = new Request('http://example.com/test', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      })
      const ctx = new Context(request)

      expect(await ctx.inputs('name', 'email')).toEqual({ name: 'alice', email: 'a@x' })
    })

    test('returns all string fields when called with no args', async () => {
      const form = new FormData()
      form.set('name', 'alice')
      form.set('avatar', new File(['x'], 'a.png', { type: 'image/png' }))
      const request = new Request('http://example.com/test', { method: 'POST', body: form })
      const ctx = new Context(request)

      const result = await ctx.inputs()
      expect(result).toEqual({ name: 'alice' })
    })

    test('missing keys return empty string', async () => {
      const body = new URLSearchParams({ name: 'alice' })
      const request = new Request('http://example.com/test', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      })
      const ctx = new Context(request)

      expect(await ctx.inputs('name', 'missing')).toEqual({ name: 'alice', missing: '' })
    })
  })

  describe('files', () => {
    test('reads File fields from multipart bodies', async () => {
      const form = new FormData()
      form.set('name', 'alice')
      const png = new File(['x'], 'a.png', { type: 'image/png' })
      form.set('avatar', png)
      const request = new Request('http://example.com/test', { method: 'POST', body: form })
      const ctx = new Context(request)

      const result = await ctx.files('avatar', 'name')
      expect(result.avatar).toBeInstanceOf(File)
      expect(result.avatar?.name).toBe('a.png')
      expect(result.name).toBeNull()
    })

    test('returns all File fields when called with no args', async () => {
      const form = new FormData()
      form.set('name', 'alice')
      form.set('avatar', new File(['x'], 'a.png', { type: 'image/png' }))
      const request = new Request('http://example.com/test', { method: 'POST', body: form })
      const ctx = new Context(request)

      const result = await ctx.files()
      expect(Object.keys(result)).toEqual(['avatar'])
      expect(result.avatar).toBeInstanceOf(File)
    })
  })
})