import { describe, test, expect } from 'bun:test'
import { Router, Context } from '../src/http/index.ts'
import { ExceptionHandler } from '@strav/kernel/exceptions/exception_handler'
import { NotFoundError } from '@strav/kernel/exceptions/http_exception'

function makeRequest(path: string, method = 'GET'): Request {
  return new Request(`http://localhost${path}`, { method })
}

describe('Router param extraction', () => {
  test('mixed :name then *wildcard pairs values with their own names', async () => {
    const router = new Router()
    let captured: Record<string, string> | undefined

    router.get('/projects/:id/specs/*relativePath', (ctx: Context) => {
      captured = ctx.params
      return new Response('ok')
    })

    const res = await router.handle(makeRequest('/projects/agon/specs/adr/0001-architecture.md'))
    expect(res).toBeDefined()
    expect((res as Response).status).toBe(200)
    expect(captured).toEqual({
      id: 'agon',
      relativePath: 'adr/0001-architecture.md',
    })
  })

  test('multiple named params (no regression)', async () => {
    const router = new Router()
    let captured: Record<string, string> | undefined

    router.get('/users/:userId/posts/:postId', (ctx: Context) => {
      captured = ctx.params
      return new Response('ok')
    })

    await router.handle(makeRequest('/users/u1/posts/p2'))
    expect(captured).toEqual({ userId: 'u1', postId: 'p2' })
  })

  test('wildcard only (no regression)', async () => {
    const router = new Router()
    let captured: Record<string, string> | undefined

    router.get('/files/*path', (ctx: Context) => {
      captured = ctx.params
      return new Response('ok')
    })

    await router.handle(makeRequest('/files/a/b/c.md'))
    expect(captured).toEqual({ path: 'a/b/c.md' })
  })
})

describe('Router no-route-match 404', () => {
  test('unmatched URL returns 404 when no exception handler is registered', async () => {
    const router = new Router()
    router.get('/', () => new Response('home'))

    const res = (await router.handle(makeRequest('/does-not-exist'))) as Response
    expect(res.status).toBe(404)
    expect(await res.text()).toContain('No route matched GET /does-not-exist')
  })

  test('unmatched URL is routed through a registered NotFoundError renderer', async () => {
    const router = new Router()
    const handler = new ExceptionHandler(false)
    handler.render(NotFoundError, () => new Response('BRANDED 404', { status: 404 }))
    router.useExceptionHandler(handler)
    router.get('/', () => new Response('home'))

    const res = (await router.handle(makeRequest('/does-not-exist'))) as Response
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('BRANDED 404')
  })

  test('the renderer receives a context carrying the unmatched path', async () => {
    const router = new Router()
    const handler = new ExceptionHandler(false)
    let seenPath: string | undefined
    handler.render(NotFoundError, (_err, ctx) => {
      seenPath = ctx?.path
      return new Response('404', { status: 404 })
    })
    router.useExceptionHandler(handler)

    await router.handle(makeRequest('/articles/missing'))
    expect(seenPath).toBe('/articles/missing')
  })

  test('unmatched non-GET requests also reach the renderer (all verbs covered)', async () => {
    const router = new Router()
    const handler = new ExceptionHandler(false)
    handler.render(NotFoundError, () => new Response('BRANDED 404', { status: 404 }))
    router.useExceptionHandler(handler)
    router.get('/', () => new Response('home'))

    const res = (await router.handle(makeRequest('/does-not-exist', 'POST'))) as Response
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('BRANDED 404')
  })

  test('a thrown NotFoundError uses the same renderer (unified pipeline)', async () => {
    const router = new Router()
    const handler = new ExceptionHandler(false)
    handler.render(NotFoundError, () => new Response('BRANDED 404', { status: 404 }))
    router.useExceptionHandler(handler)
    router.get('/projects/:id', () => {
      throw new NotFoundError('Project not found')
    })

    const res = (await router.handle(makeRequest('/projects/999'))) as Response
    expect(res.status).toBe(404)
    expect(await res.text()).toBe('BRANDED 404')
  })

  test('a matched route still resolves normally (no regression)', async () => {
    const router = new Router()
    router.get('/', () => new Response('home'))

    const res = (await router.handle(makeRequest('/'))) as Response
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('home')
  })
})
