import { describe, test, expect, afterEach } from 'bun:test'
import McpManager from '../src/mcp_manager.ts'
import { mcp } from '../src/helpers.ts'
import { mountHttpTransport } from '../src/transports/bun_http_transport.ts'
import { MemoryEventStore } from '../src/transports/memory_event_store.ts'
import { Router } from '@strav/http'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

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

function boot(eventStore?: MemoryEventStore) {
  McpManager.reset()
  new McpManager(mockConfig())
  mcp.tool('ping', {
    description: 'Ping.',
    handler: async () => ({ content: [{ type: 'text', text: 'pong' }] }),
  })
  const router = new Router()
  mountHttpTransport(router, eventStore ? { eventStore } : undefined)
  const server = Bun.serve({
    port: 0,
    fetch: req => router.handle(req) ?? new Response('Not Found', { status: 404 }),
  })
  return { server, url: `http://localhost:${server.port}/mcp` }
}

const INIT_BODY = {
  jsonrpc: '2.0' as const,
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'raw', version: '1.0' },
  },
}

const ACCEPT = 'application/json, text/event-stream'

function msg(id: number): JSONRPCMessage {
  return { jsonrpc: '2.0', id, method: 'notifications/test', params: {} } as JSONRPCMessage
}

// ── MemoryEventStore ─────────────────────────────────────────────────

describe('MemoryEventStore', () => {
  test('replays events recorded after the anchor, on the same stream', async () => {
    const store = new MemoryEventStore()
    const e1 = await store.storeEvent('s1', msg(1))
    await store.storeEvent('s1', msg(2))
    await store.storeEvent('s1', msg(3))

    const replayed: number[] = []
    const streamId = await store.replayEventsAfter(e1, {
      send: async (_id, m) => {
        replayed.push((m as any).id)
      },
    })

    expect(streamId).toBe('s1')
    expect(replayed).toEqual([2, 3]) // everything after e1
  })

  test('isolates events by stream', async () => {
    const store = new MemoryEventStore()
    const a1 = await store.storeEvent('a', msg(1))
    await store.storeEvent('b', msg(99))
    await store.storeEvent('a', msg(2))

    const replayed: number[] = []
    await store.replayEventsAfter(a1, {
      send: async (_id, m) => {
        replayed.push((m as any).id)
      },
    })
    expect(replayed).toEqual([2]) // stream "b" event not replayed
  })

  test('returns an empty stream id and replays nothing for an unknown event id', async () => {
    const store = new MemoryEventStore()
    await store.storeEvent('s1', msg(1))
    const replayed: number[] = []
    const streamId = await store.replayEventsAfter('does-not-exist', {
      send: async (_id, m) => {
        replayed.push((m as any).id)
      },
    })
    expect(streamId).toBe('')
    expect(replayed).toEqual([])
  })

  test('getStreamIdForEventId resolves the owning stream', async () => {
    const store = new MemoryEventStore()
    const id = await store.storeEvent('stream-x', msg(1))
    expect(await store.getStreamIdForEventId(id)).toBe('stream-x')
    expect(await store.getStreamIdForEventId('nope')).toBeUndefined()
  })

  test('evicts the oldest events past maxEventsPerStream', async () => {
    const store = new MemoryEventStore({ maxEventsPerStream: 2 })
    const first = await store.storeEvent('s', msg(1))
    await store.storeEvent('s', msg(2))
    await store.storeEvent('s', msg(3)) // evicts the first

    expect(await store.getStreamIdForEventId(first)).toBeUndefined()
  })
})

// ── Session conformance ──────────────────────────────────────────────

afterEach(() => {
  McpManager.reset()
})

describe('Streamable HTTP — session conformance', () => {
  test('the initialize response carries an Mcp-Session-Id header', async () => {
    const { server, url } = boot()
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: ACCEPT },
        body: JSON.stringify(INIT_BODY),
      })
      await res.text()
      expect(res.headers.get('mcp-session-id')).toBeTruthy()
    } finally {
      server.stop(true)
    }
  })

  test('a non-initialize request without a session id is rejected 400', async () => {
    const { server, url } = boot()
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: ACCEPT },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
      })
      await res.text()
      expect(res.status).toBe(400)
    } finally {
      server.stop(true)
    }
  })

  test('a request with a mismatched session id is rejected 404', async () => {
    const { server, url } = boot()
    try {
      // Initialize so the transport holds an active session.
      const initRes = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: ACCEPT },
        body: JSON.stringify(INIT_BODY),
      })
      await initRes.text()
      const session = initRes.headers.get('mcp-session-id')
      expect(session).toBeTruthy()

      // A request carrying a session id that is not the active one.
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: ACCEPT,
          'Mcp-Session-Id': `bogus-${session}`,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }),
      })
      await res.text()
      expect(res.status).toBe(404)
    } finally {
      server.stop(true)
    }
  })

  test('mounts with an EventStore for resumability; initialize still succeeds', async () => {
    const { server, url } = boot(new MemoryEventStore())
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: ACCEPT },
        body: JSON.stringify(INIT_BODY),
      })
      await res.text()
      expect(res.headers.get('mcp-session-id')).toBeTruthy()
    } finally {
      server.stop(true)
    }
  })
})
