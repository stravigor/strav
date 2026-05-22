import { describe, test, expect, afterEach } from 'bun:test'
import McpManager from '../src/mcp_manager.ts'
import { mcp } from '../src/helpers.ts'
import { mountHttpTransport } from '../src/transports/bun_http_transport.ts'
import type { McpCallerToken, McpCallerClient } from '../src/types.ts'
import { Router } from '@strav/http'
import type { Middleware } from '@strav/http'
import { Emitter } from '@strav/kernel'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

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

const validToken: McpCallerToken = {
  id: 'tok_1',
  clientId: 'client_abc',
  userId: 'user_42',
  scopes: ['mcp', 'repos:read'],
  expiresAt: new Date(Date.now() + 3_600_000),
}

/** Stand-in for `@strav/oauth2`'s `oauth()` — same Context contract, no DB. */
function fakeOAuth(
  token: McpCallerToken | null,
  opts: { client?: McpCallerClient; user?: unknown } = {}
): Middleware {
  return async (ctx, next) => {
    const header = ctx.header('authorization')
    if (!header || !header.startsWith('Bearer ')) {
      return ctx.json({ error: 'unauthenticated' }, 401)
    }
    if (!token) return ctx.json({ error: 'invalid_token' }, 401)
    ctx.set('oauth_token', token)
    if (opts.client) ctx.set('oauth_client', opts.client)
    if (opts.user !== undefined) ctx.set('user', opts.user)
    return next()
  }
}

/** Stand-in for `@strav/oauth2`'s `scopes()`. */
function fakeScopes(...required: string[]): Middleware {
  return (ctx, next) => {
    const token = ctx.get<McpCallerToken | undefined>('oauth_token')
    if (!token) return ctx.json({ error: 'unauthenticated' }, 401)
    const missing = required.filter(s => !token.scopes.includes(s))
    if (missing.length > 0) return ctx.json({ error: 'insufficient_scope' }, 403)
    return next()
  }
}

/** Boot a fresh MCP server with a `whoami` tool, mounted over HTTP. */
function boot(middleware?: Middleware[]) {
  McpManager.reset()
  new McpManager(mockConfig())

  mcp.tool('whoami', {
    description: 'Report the authenticated caller.',
    handler: async (_input, ctx) => ({
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            authenticated: !!ctx.oauth_token,
            clientId: ctx.oauth_token?.clientId ?? null,
            scopes: ctx.oauth_token?.scopes ?? [],
            userId: ctx.oauth_token?.userId ?? null,
            hasUser: ctx.user !== undefined,
            hasClient: !!ctx.oauth_client,
            hasSession: !!ctx.request?.sessionId,
          }),
        },
      ],
    }),
  })

  const router = new Router()
  mountHttpTransport(router, middleware ? { middleware } : undefined)

  const server = Bun.serve({
    port: 0,
    fetch: req => router.handle(req) ?? new Response('Not Found', { status: 404 }),
  })

  return { server, url: `http://localhost:${server.port}/mcp` }
}

/** Connect a real MCP client, call `whoami`, return the parsed identity. */
async function callWhoami(url: string, bearer?: string) {
  const transport = new StreamableHTTPClientTransport(
    new URL(url),
    bearer ? { requestInit: { headers: { Authorization: `Bearer ${bearer}` } } } : undefined
  )
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await client.connect(transport)
  const result = (await client.callTool({ name: 'whoami', arguments: {} })) as any
  await client.close()
  return JSON.parse(result.content[0].text)
}

/** Send a raw `initialize` POST — used to observe transport-level rejection. */
function rawInitialize(url: string, bearer?: string) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'raw', version: '1.0' },
      },
    }),
  })
}

// ── Tests ────────────────────────────────────────────────────────────

afterEach(() => {
  McpManager.reset()
})

describe('mountHttpTransport — unauthenticated (backward compatible)', () => {
  test('with no middleware, a tool call reaches the handler; identity is undefined', async () => {
    const { server, url } = boot()
    try {
      const id = await callWhoami(url)
      expect(id.authenticated).toBe(false)
      expect(id.scopes).toEqual([])
      expect(id.hasUser).toBe(false)
      expect(id.hasClient).toBe(false)
    } finally {
      server.stop(true)
    }
  })
})

describe('mountHttpTransport — OAuth-scoped', () => {
  test('rejects a call with no Authorization header (401) before the transport', async () => {
    const { server, url } = boot([fakeOAuth(validToken)])
    let transportHits = 0
    const spy = () => {
      transportHits++
    }
    Emitter.on('mcp:http-request', spy)
    try {
      const res = await rawInitialize(url)
      await res.text()
      expect(res.status).toBe(401)
      expect(transportHits).toBe(0) // handler/transport never reached
    } finally {
      Emitter.off('mcp:http-request', spy)
      server.stop(true)
    }
  })

  test('rejects an insufficient-scope call (403) before the transport', async () => {
    const { server, url } = boot([fakeOAuth(validToken), fakeScopes('admin')])
    let transportHits = 0
    const spy = () => {
      transportHits++
    }
    Emitter.on('mcp:http-request', spy)
    try {
      const res = await rawInitialize(url, 'bearer-without-admin-scope')
      await res.text()
      expect(res.status).toBe(403)
      expect(transportHits).toBe(0)
    } finally {
      Emitter.off('mcp:http-request', spy)
      server.stop(true)
    }
  })

  test('propagates the caller identity into the handler context', async () => {
    const client: McpCallerClient = {
      id: 'client_abc',
      name: 'Agent A',
      scopes: ['mcp'],
      confidential: true,
    }
    const { server, url } = boot([
      fakeOAuth(validToken, { client, user: { id: 'user_42' } }),
      fakeScopes('mcp'),
    ])
    try {
      const id = await callWhoami(url, 'a-valid-bearer-token')
      expect(id.authenticated).toBe(true)
      expect(id.clientId).toBe('client_abc')
      expect(id.scopes).toEqual(['mcp', 'repos:read'])
      expect(id.userId).toBe('user_42')
      expect(id.hasUser).toBe(true)
      expect(id.hasClient).toBe(true)
      expect(id.hasSession).toBe(true)
    } finally {
      server.stop(true)
    }
  })
})
