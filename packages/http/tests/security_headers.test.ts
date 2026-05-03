import { describe, test, expect } from 'bun:test'
import { Context } from '../src/http/index.ts'
import { securityHeaders } from '../src/http/security_headers.ts'
import type { Middleware, Next } from '../src/http/middleware.ts'

function makeRequest(): Context {
  return new Context(new Request('http://test/route'))
}

async function run(
  mw: Middleware,
  handler: () => Response | Promise<Response> = () => new Response('ok')
): Promise<Response> {
  const ctx = makeRequest()
  const next: Next = async () => handler()
  return mw(ctx, next)
}

describe('securityHeaders middleware', () => {
  test('default config sets the safe-default headers', async () => {
    const res = await run(securityHeaders())
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('X-Frame-Options')).toBe('SAMEORIGIN')
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin')
    expect(res.headers.get('Cross-Origin-Opener-Policy')).toBe('same-origin')
  })

  test('HSTS is OFF by default', async () => {
    const res = await run(securityHeaders())
    expect(res.headers.get('Strict-Transport-Security')).toBeNull()
  })

  test('CSP is OFF by default', async () => {
    const res = await run(securityHeaders())
    expect(res.headers.get('Content-Security-Policy')).toBeNull()
  })

  test('hsts: true enables HSTS with safe defaults', async () => {
    const res = await run(securityHeaders({ hsts: true }))
    expect(res.headers.get('Strict-Transport-Security')).toBe(
      'max-age=31536000; includeSubDomains'
    )
  })

  test('hsts options object honors maxAge / includeSubDomains / preload', async () => {
    const res = await run(
      securityHeaders({
        hsts: { maxAge: 63072000, includeSubDomains: true, preload: true },
      })
    )
    expect(res.headers.get('Strict-Transport-Security')).toBe(
      'max-age=63072000; includeSubDomains; preload'
    )
  })

  test('hsts can suppress includeSubDomains', async () => {
    const res = await run(
      securityHeaders({ hsts: { maxAge: 100, includeSubDomains: false } })
    )
    expect(res.headers.get('Strict-Transport-Security')).toBe('max-age=100')
  })

  test('frameOptions accepts DENY', async () => {
    const res = await run(securityHeaders({ frameOptions: 'DENY' }))
    expect(res.headers.get('X-Frame-Options')).toBe('DENY')
  })

  test('frameOptions=false omits the header', async () => {
    const res = await run(securityHeaders({ frameOptions: false }))
    expect(res.headers.get('X-Frame-Options')).toBeNull()
  })

  test('contentTypeOptions=false omits the header', async () => {
    const res = await run(securityHeaders({ contentTypeOptions: false }))
    expect(res.headers.get('X-Content-Type-Options')).toBeNull()
  })

  test('referrerPolicy accepts custom value and false omits', async () => {
    const r1 = await run(securityHeaders({ referrerPolicy: 'no-referrer' }))
    expect(r1.headers.get('Referrer-Policy')).toBe('no-referrer')
    const r2 = await run(securityHeaders({ referrerPolicy: false }))
    expect(r2.headers.get('Referrer-Policy')).toBeNull()
  })

  test('csp string is set verbatim', async () => {
    const policy = "default-src 'self'; img-src 'self' data:"
    const res = await run(securityHeaders({ csp: policy }))
    expect(res.headers.get('Content-Security-Policy')).toBe(policy)
  })

  test('crossOriginOpenerPolicy can be customized or omitted', async () => {
    const r1 = await run(securityHeaders({ crossOriginOpenerPolicy: 'unsafe-none' }))
    expect(r1.headers.get('Cross-Origin-Opener-Policy')).toBe('unsafe-none')
    const r2 = await run(securityHeaders({ crossOriginOpenerPolicy: false }))
    expect(r2.headers.get('Cross-Origin-Opener-Policy')).toBeNull()
  })

  test('does not overwrite headers set by the route handler', async () => {
    // A per-route response that sets X-Frame-Options: DENY should not
    // be downgraded to SAMEORIGIN by the global middleware.
    const res = await run(securityHeaders(), () => {
      const r = new Response('ok')
      r.headers.set('X-Frame-Options', 'DENY')
      return r
    })
    expect(res.headers.get('X-Frame-Options')).toBe('DENY')
  })

  test('returns the same response object passed through next()', async () => {
    const handlerResponse = new Response('hello', { status: 201 })
    const res = await run(securityHeaders(), () => handlerResponse)
    expect(res).toBe(handlerResponse)
    expect(res.status).toBe(201)
    expect(await res.text()).toBe('hello')
  })
})
