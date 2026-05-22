import { describe, test, expect, afterEach } from 'bun:test'
import { z } from 'zod'
import McpManager from '../src/mcp_manager.ts'
import { mcp } from '../src/helpers.ts'
import { mountHttpTransport } from '../src/transports/bun_http_transport.ts'
import { McpClient } from '../src/client/mcp_client.ts'
import type { McpCallerToken } from '../src/types.ts'
import { Router } from '@strav/http'
import type { Middleware } from '@strav/http'

// ── Fixtures ─────────────────────────────────────────────────────────

function mockConfig() {
  const data: Record<string, unknown> = {
    mcp: { name: 'test-server', version: '1.0.0', http: { enabled: false, path: '/mcp' } },
    app: { name: 'Test App' },
  }
  return {
    get(key: string, defaultValue?: unknown): unknown {
      let current: any = data
      for (const part of key.split('.')) {
        if (current == null) return defaultValue
        current = current[part]
      }
      return current !== undefined ? current : defaultValue
    },
  } as any
}

const token: McpCallerToken = {
  id: 'tok_1',
  clientId: 'client_abc',
  userId: null,
  scopes: ['mcp'],
  expiresAt: new Date(Date.now() + 3_600_000),
}

/** Minimal Bearer-token gate, mirroring `@strav/oauth2`'s `oauth()`. */
function requireBearer(): Middleware {
  return async (ctx, next) => {
    const header = ctx.header('authorization')
    if (!header || !header.startsWith('Bearer ')) {
      return ctx.json({ error: 'unauthenticated' }, 401)
    }
    ctx.set('oauth_token', token)
    return next()
  }
}

function boot(middleware?: Middleware[]) {
  McpManager.reset()
  new McpManager(mockConfig())

  mcp.tool('greet', {
    description: 'Greet someone by name.',
    input: { name: z.string() },
    handler: async ({ name }) => ({ content: [{ type: 'text', text: `Hello, ${name}!` }] }),
  })

  const router = new Router()
  mountHttpTransport(router, middleware ? { middleware } : undefined)
  const server = Bun.serve({
    port: 0,
    fetch: req => router.handle(req) ?? new Response('Not Found', { status: 404 }),
  })
  return { server, url: `http://localhost:${server.port}/mcp` }
}

// ── Tests ────────────────────────────────────────────────────────────

afterEach(() => {
  McpManager.reset()
})

describe('McpClient', () => {
  test('lists the remote server tools', async () => {
    const { server, url } = boot()
    const client = new McpClient({ url })
    try {
      const tools = await client.listTools()
      expect(tools.map(t => t.name)).toEqual(['greet'])
      expect(tools[0]!.description).toBe('Greet someone by name.')
      expect(tools[0]!.inputSchema.type).toBe('object')
    } finally {
      await client.close()
      server.stop(true)
    }
  })

  test('calls a remote tool and returns its result', async () => {
    const { server, url } = boot()
    const client = new McpClient({ url })
    try {
      const result = await client.callTool('greet', { name: 'World' })
      expect((result.content[0] as any).text).toBe('Hello, World!')
    } finally {
      await client.close()
      server.stop(true)
    }
  })

  test('sends the bearer token to an OAuth-scoped server', async () => {
    const { server, url } = boot([requireBearer()])
    const client = new McpClient({ url, bearerToken: 'a-valid-token' })
    try {
      const result = await client.callTool('greet', { name: 'Agent' })
      expect((result.content[0] as any).text).toBe('Hello, Agent!')
    } finally {
      await client.close()
      server.stop(true)
    }
  })

  test('fails to connect to an OAuth-scoped server without a token', async () => {
    const { server, url } = boot([requireBearer()])
    const client = new McpClient({ url })
    try {
      await expect(client.listTools()).rejects.toThrow()
    } finally {
      await client.close()
      server.stop(true)
    }
  })
})
