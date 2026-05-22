import { describe, test, expect, afterEach } from 'bun:test'
import { z } from 'zod'
import McpManager from '../src/mcp_manager.ts'
import { mcp } from '../src/helpers.ts'
import { mountHttpTransport } from '../src/transports/bun_http_transport.ts'
import { DuplicateRegistrationError } from '../src/errors.ts'
import { Router } from '@strav/http'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { takeResult } from '@modelcontextprotocol/sdk/experimental'

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

function boot(register: () => void) {
  McpManager.reset()
  new McpManager(mockConfig())
  register()
  const router = new Router()
  mountHttpTransport(router)
  const server = Bun.serve({
    port: 0,
    fetch: req => router.handle(req) ?? new Response('Not Found', { status: 404 }),
  })
  return { server, url: `http://localhost:${server.port}/mcp` }
}

async function runTask(url: string, name: string, args: Record<string, unknown> = {}) {
  const transport = new StreamableHTTPClientTransport(new URL(url))
  const client = new Client({ name: 'test-client', version: '1.0.0' })
  await client.connect(transport)
  // List tools first so the client learns which tools are task-augmented.
  await client.listTools()
  let outcome: any
  try {
    outcome = await takeResult(
      client.experimental.tasks.callToolStream({ name, arguments: args })
    )
  } catch (err) {
    outcome = { thrown: true, message: String(err) }
  }
  await client.close()
  return outcome
}

// ── Tests ────────────────────────────────────────────────────────────

afterEach(() => {
  McpManager.reset()
})

describe('mcp.task — registration', () => {
  test('registers a task', () => {
    McpManager.reset()
    new McpManager(mockConfig())
    mcp.task('deploy', {
      description: 'Deploy a milestone',
      input: { id: z.string() },
      handler: async () => ({ content: [] }),
    })
    expect(mcp.registeredTasks()).toEqual(['deploy'])
    expect(mcp.getTaskRegistration('deploy')?.taskSupport).toBe('required')
  })

  test('throws on a duplicate task name', () => {
    McpManager.reset()
    new McpManager(mockConfig())
    mcp.task('dup', { handler: async () => ({ content: [] }) })
    expect(() => mcp.task('dup', { handler: async () => ({ content: [] }) })).toThrow(
      DuplicateRegistrationError
    )
  })

  test('throws when a task name collides with a tool name', () => {
    McpManager.reset()
    new McpManager(mockConfig())
    mcp.tool('shared', { handler: async () => ({ content: [] }) })
    expect(() => mcp.task('shared', { handler: async () => ({ content: [] }) })).toThrow(
      DuplicateRegistrationError
    )
  })
})

describe('mcp.task — fire and poll', () => {
  test('a task runs in the background; the client polls it to completion', async () => {
    const { server, url } = boot(() => {
      mcp.task('echo-slow', {
        description: 'Echo after a short delay',
        input: { message: z.string() },
        pollInterval: 50,
        handler: async ({ message }) => {
          await new Promise(r => setTimeout(r, 20))
          return { content: [{ type: 'text', text: `echo: ${message}` }] }
        },
      })
    })
    try {
      const result = await runTask(url, 'echo-slow', { message: 'hi' })
      expect(result.content[0].text).toBe('echo: hi')
    } finally {
      server.stop(true)
    }
  })

  test('a failed task surfaces the failure to the polling client', async () => {
    const { server, url } = boot(() => {
      mcp.task('boom', {
        description: 'Always fails',
        pollInterval: 50,
        handler: async () => {
          throw new Error('kaboom')
        },
      })
    })
    try {
      const outcome = await runTask(url, 'boom')
      // The failure is surfaced to the polling client (takeResult throws).
      expect(outcome.thrown).toBe(true)
      expect(String(outcome.message).toLowerCase()).toContain('fail')
    } finally {
      server.stop(true)
    }
  })
})
