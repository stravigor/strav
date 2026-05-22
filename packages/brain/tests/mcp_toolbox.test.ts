import { describe, test, expect, afterEach } from 'bun:test'
import { z } from 'zod'
import McpManager, { mcp, mountHttpTransport } from '@strav/mcp'
import { Router } from '@strav/http'
import { defineMcpToolbox } from '../src/mcp_toolbox.ts'

// ── Fixtures ─────────────────────────────────────────────────────────

function mockConfig() {
  const data: Record<string, unknown> = {
    mcp: { name: 'gateway', version: '1.0.0', http: { enabled: false, path: '/mcp' } },
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

/** Boot an MCP gateway exposing two tools over HTTP. */
function bootGateway() {
  McpManager.reset()
  new McpManager(mockConfig())

  mcp.tool('add', {
    description: 'Add two numbers.',
    input: { a: z.number(), b: z.number() },
    handler: async ({ a, b }) => ({ content: [{ type: 'text', text: String(a + b) }] }),
  })
  mcp.tool('shout', {
    description: 'Uppercase a string.',
    input: { text: z.string() },
    handler: async ({ text }) => ({ content: [{ type: 'text', text: text.toUpperCase() }] }),
  })

  const router = new Router()
  mountHttpTransport(router)
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

describe('defineMcpToolbox', () => {
  test('maps every remote MCP tool to a brain ToolDefinition', async () => {
    const { server, url } = bootGateway()
    try {
      const toolbox = await defineMcpToolbox('gateway', { url })
      expect(toolbox.map(t => t.name).sort()).toEqual(['add', 'shout'])

      const add = toolbox.find(t => t.name === 'add')!
      expect(add.description).toBe('Add two numbers.')
      expect((add.parameters as any).type).toBe('object')
      expect(typeof add.execute).toBe('function')
    } finally {
      server.stop(true)
    }
  })

  test('execute() performs the remote MCP call', async () => {
    const { server, url } = bootGateway()
    try {
      const toolbox = await defineMcpToolbox('gateway', { url })
      const add = toolbox.find(t => t.name === 'add')!
      const shout = toolbox.find(t => t.name === 'shout')!

      expect(await add.execute({ a: 2, b: 3 })).toBe('5')
      expect(await shout.execute({ text: 'hi' })).toBe('HI')
    } finally {
      server.stop(true)
    }
  })

  test('the `only` filter restricts the toolbox', async () => {
    const { server, url } = bootGateway()
    try {
      const toolbox = await defineMcpToolbox('gateway', { url, only: ['shout'] })
      expect(toolbox.map(t => t.name)).toEqual(['shout'])
    } finally {
      server.stop(true)
    }
  })
})
