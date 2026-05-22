import { describe, test, expect, afterEach } from 'bun:test'
import { z } from 'zod'
import McpManager from '../src/mcp_manager.ts'
import { mcp } from '../src/helpers.ts'
import { mountHttpTransport } from '../src/transports/bun_http_transport.ts'
import { confirmation, wasApproved } from '../src/elicitation.ts'
import { Router } from '@strav/http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ElicitRequestSchema } from '@modelcontextprotocol/sdk/types.js'

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

function boot() {
  McpManager.reset()
  new McpManager(mockConfig())

  mcp.tool('deploy', {
    description: 'Deploy with a human confirmation step.',
    input: { target: z.string() },
    handler: async ({ target }, ctx) => {
      if (!ctx.elicit) {
        return { content: [{ type: 'text', text: 'elicitation unavailable' }], isError: true }
      }
      const answer = await ctx.elicit(confirmation(`Deploy to ${target}?`))
      return {
        content: [
          {
            type: 'text',
            text: wasApproved(answer) ? `deployed to ${target}` : 'cancelled',
          },
        ],
      }
    },
  })

  const router = new Router()
  mountHttpTransport(router)
  const server = Bun.serve({
    port: 0,
    fetch: req => router.handle(req) ?? new Response('Not Found', { status: 404 }),
  })
  return { server, url: `http://localhost:${server.port}/mcp` }
}

/** Connect a client that answers every elicitation with the given action. */
async function deployAnswering(url: string, action: 'accept' | 'decline') {
  const transport = new StreamableHTTPClientTransport(new URL(url))
  const client = new Client(
    { name: 'test-client', version: '1.0.0' },
    { capabilities: { elicitation: {} } }
  )
  client.setRequestHandler(ElicitRequestSchema, async () => ({ action }))
  await client.connect(transport)
  const result = (await client.callTool({ name: 'deploy', arguments: { target: 'prod' } })) as any
  await client.close()
  return result
}

// ── Tests ────────────────────────────────────────────────────────────

afterEach(() => {
  McpManager.reset()
})

describe('MCP Elicitation', () => {
  test('a tool pauses for a human confirmation and resumes on accept', async () => {
    const { server, url } = boot()
    try {
      const result = await deployAnswering(url, 'accept')
      expect(result.content[0].text).toBe('deployed to prod')
    } finally {
      server.stop(true)
    }
  })

  test('a declined confirmation steers the tool down the cancel path', async () => {
    const { server, url } = boot()
    try {
      const result = await deployAnswering(url, 'decline')
      expect(result.content[0].text).toBe('cancelled')
    } finally {
      server.stop(true)
    }
  })
})
