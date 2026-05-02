import { describe, test, expect } from 'bun:test'
import { Context } from '../src/http/index.ts'
import {
  idempotency,
  MemoryIdempotencyStore,
  type CapturedResponse,
  type IdempotencyStore,
} from '../src/http/idempotency.ts'
import type { Middleware, Next } from '../src/http/middleware.ts'

function makeRequest(opts: {
  method?: string
  url?: string
  headers?: Record<string, string>
  body?: string
} = {}): Context {
  const init: RequestInit = {
    method: opts.method ?? 'POST',
    headers: opts.headers ?? {},
  }
  if (opts.body !== undefined) init.body = opts.body
  return new Context(new Request(opts.url ?? 'http://test/route', init))
}

async function run(
  middleware: Middleware,
  ctx: Context,
  handler: () => Response | Promise<Response>
): Promise<Response> {
  const next: Next = async () => handler()
  return middleware(ctx, next)
}

describe('idempotency middleware', () => {
  test('passes through when method is not covered', async () => {
    const mw = idempotency({ store: new MemoryIdempotencyStore() })
    const ctx = makeRequest({ method: 'GET' })
    const res = await run(mw, ctx, () => new Response('ok', { status: 200 }))
    expect(res.status).toBe(200)
    expect(res.headers.get('Idempotent-Replay')).toBeNull()
  })

  test('passes through when key is missing and not required', async () => {
    const mw = idempotency()
    const ctx = makeRequest()
    const res = await run(mw, ctx, () => new Response('ok'))
    expect(res.status).toBe(200)
  })

  test('returns 400 when key is required but missing', async () => {
    const mw = idempotency({ required: true })
    const ctx = makeRequest()
    const res = await run(mw, ctx, () => new Response('ok'))
    expect(res.status).toBe(400)
    const json = (await res.json()) as { error: string }
    expect(json.error).toMatch(/required/)
  })

  test('first request runs the handler and replays on the second call', async () => {
    const store = new MemoryIdempotencyStore()
    const mw = idempotency({ store })
    let calls = 0

    const r1 = await run(
      mw,
      makeRequest({ headers: { 'Idempotency-Key': 'k1' }, body: '{"x":1}' }),
      () => {
        calls++
        return Response.json({ ok: true, count: calls }, { status: 201 })
      }
    )
    expect(r1.status).toBe(201)
    expect(calls).toBe(1)

    const r2 = await run(
      mw,
      makeRequest({ headers: { 'Idempotency-Key': 'k1' }, body: '{"x":1}' }),
      () => {
        calls++
        return Response.json({ ok: true, count: calls }, { status: 201 })
      }
    )
    expect(r2.status).toBe(201)
    expect(calls).toBe(1) // handler did not run again
    expect(r2.headers.get('Idempotent-Replay')).toBe('true')
    const body = (await r2.json()) as { count: number }
    expect(body.count).toBe(1) // returned the cached value
  })

  test('rejects same key with a different body as 422', async () => {
    const store = new MemoryIdempotencyStore()
    const mw = idempotency({ store })

    await run(
      mw,
      makeRequest({ headers: { 'Idempotency-Key': 'k2' }, body: '{"x":1}' }),
      () => new Response('ok')
    )

    const res = await run(
      mw,
      makeRequest({ headers: { 'Idempotency-Key': 'k2' }, body: '{"x":2}' }),
      () => new Response('SHOULD NOT RUN')
    )
    expect(res.status).toBe(422)
    const json = (await res.json()) as { error: string }
    expect(json.error).toMatch(/different request body/)
  })

  test('rejects same key with a different path as 422', async () => {
    const store = new MemoryIdempotencyStore()
    const mw = idempotency({ store })

    await run(
      mw,
      makeRequest({
        headers: { 'Idempotency-Key': 'k3' },
        url: 'http://test/a',
        body: '',
      }),
      () => new Response('ok')
    )

    const res = await run(
      mw,
      makeRequest({
        headers: { 'Idempotency-Key': 'k3' },
        url: 'http://test/b',
        body: '',
      }),
      () => new Response('NEVER')
    )
    expect(res.status).toBe(422)
  })

  test('5xx responses do not get cached (key is released)', async () => {
    const store = new MemoryIdempotencyStore()
    const mw = idempotency({ store })
    let calls = 0
    const handler = () => {
      calls++
      return new Response('boom', { status: 500 })
    }

    const r1 = await run(
      mw,
      makeRequest({ headers: { 'Idempotency-Key': 'k4' } }),
      handler
    )
    expect(r1.status).toBe(500)

    const r2 = await run(
      mw,
      makeRequest({ headers: { 'Idempotency-Key': 'k4' } }),
      handler
    )
    expect(r2.status).toBe(500)
    expect(calls).toBe(2) // not cached, ran again
  })

  test('4xx responses ARE cached (client errors are inherent to the request)', async () => {
    const store = new MemoryIdempotencyStore()
    const mw = idempotency({ store })
    let calls = 0
    const handler = () => {
      calls++
      return Response.json({ error: 'invalid' }, { status: 400 })
    }

    await run(mw, makeRequest({ headers: { 'Idempotency-Key': 'k5' } }), handler)
    await run(mw, makeRequest({ headers: { 'Idempotency-Key': 'k5' } }), handler)

    expect(calls).toBe(1)
  })

  test('thrown handler releases the key', async () => {
    const store = new MemoryIdempotencyStore()
    const mw = idempotency({ store })
    let calls = 0
    const handler = () => {
      calls++
      throw new Error('boom')
    }

    await expect(
      run(mw, makeRequest({ headers: { 'Idempotency-Key': 'k6' } }), handler)
    ).rejects.toThrow(/boom/)

    // Second request can re-run because the key was released
    await expect(
      run(mw, makeRequest({ headers: { 'Idempotency-Key': 'k6' } }), handler)
    ).rejects.toThrow(/boom/)
    expect(calls).toBe(2)
  })

  test('concurrent requests with the same key — only one runs the handler, the other gets 409 if still in flight', async () => {
    const store = new MemoryIdempotencyStore()
    const mw = idempotency({ store })
    let resolveHandler: ((r: Response) => void) | null = null

    const inFlight = run(
      mw,
      makeRequest({ headers: { 'Idempotency-Key': 'k7' }, body: '{"a":1}' }),
      () =>
        new Promise<Response>(resolve => {
          resolveHandler = resolve
        })
    )

    // While inFlight is paused, fire a second request with the same key+body
    const second = await run(
      mw,
      makeRequest({ headers: { 'Idempotency-Key': 'k7' }, body: '{"a":1}' }),
      () => new Response('SHOULD NOT RUN')
    )
    expect(second.status).toBe(409)

    // Complete the in-flight request
    resolveHandler!(new Response('done', { status: 200 }))
    const first = await inFlight
    expect(first.status).toBe(200)
  })

  test('preserves response headers and body bytes on replay', async () => {
    const store = new MemoryIdempotencyStore()
    const mw = idempotency({ store })

    await run(
      mw,
      makeRequest({ headers: { 'Idempotency-Key': 'k8' }, body: '{}' }),
      () =>
        new Response('hello bytes', {
          status: 202,
          headers: { 'X-Custom': 'yes', 'Content-Type': 'text/plain' },
        })
    )

    const r2 = await run(
      mw,
      makeRequest({ headers: { 'Idempotency-Key': 'k8' }, body: '{}' }),
      () => new Response('NEVER')
    )
    expect(r2.status).toBe(202)
    expect(r2.headers.get('X-Custom')).toBe('yes')
    expect(r2.headers.get('Content-Type')).toBe('text/plain')
    expect(r2.headers.get('Idempotent-Replay')).toBe('true')
    expect(await r2.text()).toBe('hello bytes')
  })

  test('custom header name is respected', async () => {
    const store = new MemoryIdempotencyStore()
    const mw = idempotency({ store, header: 'X-Idem' })

    let calls = 0
    await run(
      mw,
      makeRequest({ headers: { 'X-Idem': 'k9' }, body: '{}' }),
      () => {
        calls++
        return new Response('ok')
      }
    )
    await run(
      mw,
      makeRequest({ headers: { 'X-Idem': 'k9' }, body: '{}' }),
      () => {
        calls++
        return new Response('ok')
      }
    )
    expect(calls).toBe(1)
  })

  test('TTL — expired records do not block a fresh request', async () => {
    const store = new MemoryIdempotencyStore()
    const mw = idempotency({ store, ttl: 5 }) // 5 ms

    let calls = 0
    const handler = () => {
      calls++
      return new Response('ok')
    }

    await run(mw, makeRequest({ headers: { 'Idempotency-Key': 'k10' } }), handler)
    await new Promise(r => setTimeout(r, 20))
    await run(mw, makeRequest({ headers: { 'Idempotency-Key': 'k10' } }), handler)
    expect(calls).toBe(2)
  })

  test('custom store interface is honored', async () => {
    const events: string[] = []
    const store: IdempotencyStore = {
      async reserve() {
        events.push('reserve')
        return { status: 'inserted' }
      },
      async complete(_, response: CapturedResponse) {
        events.push(`complete:${response.status}`)
      },
      async release() {
        events.push('release')
      },
    }
    const mw = idempotency({ store })
    await run(
      mw,
      makeRequest({ headers: { 'Idempotency-Key': 'k11' } }),
      () => new Response('ok', { status: 200 })
    )
    expect(events).toEqual(['reserve', 'complete:200'])
  })
})
