import { describe, test, expect } from 'bun:test'
import { Context } from '../src/http/index.ts'
import { csrf } from '../src/auth/middleware/csrf.ts'

const TOKEN = 'abc123'

function ctxWithSession(request: Request): Context {
  const ctx = new Context(request)
  ctx.set('session', { csrfToken: TOKEN })
  return ctx
}

const next = async () => new Response('ok', { status: 200 })

describe('csrf()', () => {
  test('accepts urlencoded form POST with valid _token', async () => {
    const body = new URLSearchParams({ _token: TOKEN, name: 'alice' })
    const request = new Request('http://example.com/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
    const ctx = ctxWithSession(request)

    const res = await csrf()(ctx, next)

    expect(res.status).toBe(200)
  })

  test('accepts multipart form POST with valid _token', async () => {
    const form = new FormData()
    form.set('_token', TOKEN)
    form.set('name', 'alice')
    const request = new Request('http://example.com/login', { method: 'POST', body: form })
    const ctx = ctxWithSession(request)

    const res = await csrf()(ctx, next)

    expect(res.status).toBe(200)
  })

  test('accepts JSON POST with valid _token', async () => {
    const request = new Request('http://example.com/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ _token: TOKEN }),
    })
    const ctx = ctxWithSession(request)

    const res = await csrf()(ctx, next)

    expect(res.status).toBe(200)
  })

  test('accepts header-based token (X-CSRF-Token)', async () => {
    const request = new Request('http://example.com/api', {
      method: 'POST',
      headers: { 'x-csrf-token': TOKEN, 'content-type': 'application/json' },
      body: '{}',
    })
    const ctx = ctxWithSession(request)

    const res = await csrf()(ctx, next)

    expect(res.status).toBe(200)
  })

  test('rejects form POST with missing _token', async () => {
    const body = new URLSearchParams({ name: 'alice' })
    const request = new Request('http://example.com/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
    const ctx = ctxWithSession(request)

    const res = await csrf()(ctx, next)

    expect(res.status).toBe(403)
  })

  test('rejects form POST with wrong _token', async () => {
    const body = new URLSearchParams({ _token: 'wrong' })
    const request = new Request('http://example.com/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
    const ctx = ctxWithSession(request)

    const res = await csrf()(ctx, next)

    expect(res.status).toBe(403)
  })

  test('skips check on GET and exposes csrfToken', async () => {
    const request = new Request('http://example.com/page', { method: 'GET' })
    const ctx = ctxWithSession(request)

    const res = await csrf()(ctx, next)

    expect(res.status).toBe(200)
    expect(ctx.get('csrfToken')).toBe(TOKEN)
  })

  test('rejects POST without a session', async () => {
    const request = new Request('http://example.com/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ _token: TOKEN }),
    })
    const ctx = new Context(request)

    const res = await csrf()(ctx, next)

    expect(res.status).toBe(403)
  })
})
