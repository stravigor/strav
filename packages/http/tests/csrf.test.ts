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

  test('default body is { error: string }', async () => {
    const body = new URLSearchParams({ name: 'alice' })
    const request = new Request('http://example.com/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
    const ctx = ctxWithSession(request)

    const res = await csrf()(ctx, next)

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'CSRF token mismatch' })
  })
})

describe('csrf({ onFail })', () => {
  test('onFail shapes the failure response', async () => {
    const body = new URLSearchParams({ name: 'alice' })
    const request = new Request('http://example.com/login', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
    const ctx = ctxWithSession(request)

    const res = await csrf({
      onFail: (c, reason) =>
        c.json({ error_code: 'CSRF_FAILED', message: reason, details: {} }, 403),
    })(ctx, next)

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({
      error_code: 'CSRF_FAILED',
      message: 'missing-token',
      details: {},
    })
  })

  test('reports reason "no-session" when no session exists', async () => {
    const request = new Request('http://example.com/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ _token: TOKEN }),
    })
    const ctx = new Context(request)
    let seen: string | undefined

    await csrf({
      onFail: (c, reason) => {
        seen = reason
        return c.json({}, 403)
      },
    })(ctx, next)

    expect(seen).toBe('no-session')
  })

  test('reports reason "missing-token" when no token is supplied', async () => {
    const request = new Request('http://example.com/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    const ctx = ctxWithSession(request)
    let seen: string | undefined

    await csrf({
      onFail: (c, reason) => {
        seen = reason
        return c.json({}, 403)
      },
    })(ctx, next)

    expect(seen).toBe('missing-token')
  })

  test('reports reason "token-mismatch" when token does not match', async () => {
    const request = new Request('http://example.com/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ _token: 'wrong' }),
    })
    const ctx = ctxWithSession(request)
    let seen: string | undefined

    await csrf({
      onFail: (c, reason) => {
        seen = reason
        return c.json({}, 403)
      },
    })(ctx, next)

    expect(seen).toBe('token-mismatch')
  })

  test('supports an async onFail', async () => {
    const request = new Request('http://example.com/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    const ctx = ctxWithSession(request)

    const res = await csrf({
      onFail: async (c) => c.json({ error_code: 'ASYNC' }, 403),
    })(ctx, next)

    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error_code: 'ASYNC' })
  })

  test('a valid request still passes with onFail set', async () => {
    const request = new Request('http://example.com/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ _token: TOKEN }),
    })
    const ctx = ctxWithSession(request)

    const res = await csrf({ onFail: (c) => c.json({}, 403) })(ctx, next)

    expect(res.status).toBe(200)
  })
})
