import { describe, test, expect } from 'bun:test'
import { Router, Context } from '../src/http/index.ts'

function makeRequest(path: string): Request {
  return new Request(`http://localhost${path}`)
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
