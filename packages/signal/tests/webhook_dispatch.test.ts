import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Queue } from '@strav/queue'
import WebhookManager from '../src/webhook/webhook_manager.ts'
import { MemoryWebhookStore } from '../src/webhook/storage/memory_store.ts'

interface CapturedRequest {
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

const originalFetch = globalThis.fetch
const originalQueuePush = Queue.push
let calls: CapturedRequest[] = []
let queuePushes: { name: string; payload: unknown; options?: unknown }[] = []

type Responder = (req: CapturedRequest) => Response | Promise<Response>

function installFetch(responder: Responder): void {
  globalThis.fetch = (async (...args: unknown[]) => {
    const [input, init] = args as [string, RequestInit]
    const headers = headersToObject(init.headers)
    const body = typeof init.body === 'string' ? init.body : ''
    const captured: CapturedRequest = {
      url: typeof input === 'string' ? input : input.toString(),
      method: init.method ?? 'GET',
      headers,
      body,
    }
    calls.push(captured)
    return responder(captured)
  }) as typeof fetch
}

function headersToObject(input: HeadersInit | undefined): Record<string, string> {
  if (!input) return {}
  const out: Record<string, string> = {}
  if (input instanceof Headers) {
    input.forEach((v, k) => { out[k.toLowerCase()] = v })
    return out
  }
  if (Array.isArray(input)) return Object.fromEntries(input.map(([k, v]) => [k.toLowerCase(), v]))
  for (const [k, v] of Object.entries(input as Record<string, string>)) {
    out[k.toLowerCase()] = v
  }
  return out
}

function mockConfig(overrides: Record<string, unknown> = {}) {
  const data: Record<string, unknown> = {
    webhook: {
      driver: 'memory',
      maxAttempts: 3,
      baseDelayMs: 1000,
      factor: 2,
      ceilingMs: 60_000,
      jitter: 0,
      responseBodyLimit: 65_536,
      fetchTimeoutMs: 15_000,
      ...overrides,
    },
  }
  return {
    get(key: string, def?: unknown) {
      const parts = key.split('.')
      let cur: any = data
      for (const p of parts) cur = cur?.[p]
      return cur !== undefined ? cur : def
    },
    has(key: string) { return this.get(key) !== undefined },
  } as any
}

let store: MemoryWebhookStore

beforeEach(() => {
  calls = []
  queuePushes = []
  store = new MemoryWebhookStore()
  new WebhookManager(mockConfig())
  WebhookManager.useStore(store)
  // Stub Queue.push so dispatch's "queue this delivery" calls don't need a real Queue.
  ;(Queue as any).push = async (name: string, payload: unknown, options?: unknown) => {
    queuePushes.push({ name, payload, options })
    return queuePushes.length
  }
})

afterEach(() => {
  globalThis.fetch = originalFetch
  ;(Queue as any).push = originalQueuePush
  WebhookManager.reset()
})

describe('webhook.endpoints', () => {
  test('create / get / list / update / delete round trip', async () => {
    const ep = await WebhookManager.createEndpoint({
      url: 'https://example.com/hook',
      secret: 's',
      events: ['lead.created'],
    })
    expect(ep.id).toBeTruthy()
    expect(ep.active).toBe(true)

    const fetched = await WebhookManager.getEndpoint(ep.id)
    expect(fetched?.url).toBe('https://example.com/hook')

    const list = await WebhookManager.listEndpoints()
    expect(list).toHaveLength(1)

    const updated = await WebhookManager.updateEndpoint(ep.id, { active: false })
    expect(updated?.active).toBe(false)

    await WebhookManager.deleteEndpoint(ep.id)
    expect(await WebhookManager.getEndpoint(ep.id)).toBeNull()
  })
})

describe('WebhookManager.dispatch', () => {
  test('fans out to every endpoint subscribed to the event', async () => {
    const e1 = await WebhookManager.createEndpoint({
      url: 'https://a.test/hook', secret: 's1', events: ['lead.created'],
    })
    const e2 = await WebhookManager.createEndpoint({
      url: 'https://b.test/hook', secret: 's2', events: ['*'],
    })
    const e3 = await WebhookManager.createEndpoint({
      url: 'https://c.test/hook', secret: 's3', events: ['lead.deleted'],
    })

    const result = await WebhookManager.dispatch('lead.created', { id: 1 })
    expect(result.deliveries).toHaveLength(2)
    expect(result.deliveries.map(d => d.endpointId).sort()).toEqual([e1.id, e2.id].sort())
    expect(queuePushes).toHaveLength(2)
    expect(queuePushes[0]!.name).toBe('strav:webhook-deliver')
    void e3  // unused — confirming exclusion
  })

  test('skips inactive endpoints', async () => {
    await WebhookManager.createEndpoint({
      url: 'https://x.test/hook', secret: 's', events: ['e'], active: false,
    })
    const result = await WebhookManager.dispatch('e', {})
    expect(result.deliveries).toEqual([])
  })

  test('immediate=true performs delivery synchronously and skips the queue', async () => {
    installFetch(() => new Response('ok', { status: 200 }))
    await WebhookManager.createEndpoint({
      url: 'https://example.com/hook', secret: 's', events: ['e'],
    })

    const result = await WebhookManager.dispatch('e', { id: 1 }, { immediate: true })
    expect(queuePushes).toHaveLength(0) // no queue.push for the initial dispatch
    expect(calls).toHaveLength(1)

    const final = await WebhookManager.store.getDelivery(result.deliveries[0]!.id)
    expect(final?.status).toBe('delivered')
    expect(final?.attempts).toBe(1)
  })
})

describe('WebhookManager.deliverNow', () => {
  test('signs the request with the documented header set', async () => {
    installFetch(() => new Response('ok', { status: 200 }))
    const ep = await WebhookManager.createEndpoint({
      url: 'https://example.com/hook', secret: 's', events: ['e'],
    })
    const { deliveries } = await WebhookManager.dispatch('e', { id: 7 }, { immediate: true })
    const id = deliveries[0]!.id

    expect(calls).toHaveLength(1)
    const h = calls[0]!.headers
    expect(h['x-strav-delivery']).toBe(id)
    expect(h['x-strav-event']).toBe('e')
    expect(h['x-strav-timestamp']).toMatch(/^\d+$/)
    expect(h['x-strav-signature']).toMatch(/^sha256=[0-9a-f]{64}$/)
    expect(calls[0]!.body).toBe(JSON.stringify({ id: 7 }))
    void ep
  })

  test('schedules a retry with delay when delivery fails', async () => {
    installFetch(() => new Response('boom', { status: 500 }))
    await WebhookManager.createEndpoint({
      url: 'https://example.com/hook', secret: 's', events: ['e'],
    })
    const { deliveries } = await WebhookManager.dispatch('e', {}, { immediate: true })
    const id = deliveries[0]!.id

    const final = await WebhookManager.store.getDelivery(id)
    expect(final?.status).toBe('pending')
    expect(final?.attempts).toBe(1)
    expect(final?.responseStatus).toBe(500)
    expect(final?.nextRetryAt).toBeInstanceOf(Date)
    // Retry was queued (immediate=true triggered deliverNow → schedule retry)
    const retryPushes = queuePushes.filter(p => p.name === 'strav:webhook-deliver')
    expect(retryPushes).toHaveLength(1)
    expect((retryPushes[0]!.options as any).delay).toBe(1000)
  })

  test('marks the delivery dead after maxAttempts', async () => {
    installFetch(() => new Response('boom', { status: 500 }))
    await WebhookManager.createEndpoint({
      url: 'https://example.com/hook', secret: 's', events: ['e'],
    })
    const { deliveries } = await WebhookManager.dispatch('e', {}, { immediate: true })
    const id = deliveries[0]!.id

    // Two more deliverNow() calls reach maxAttempts (3)
    await WebhookManager.deliverNow(id)
    const final = await WebhookManager.deliverNow(id)
    expect(final?.status).toBe('dead')
    expect(final?.attempts).toBe(3)
  })

  test('replay() re-queues a dead delivery', async () => {
    installFetch(() => new Response('boom', { status: 500 }))
    await WebhookManager.createEndpoint({
      url: 'https://example.com/hook', secret: 's', events: ['e'],
    })
    const { deliveries } = await WebhookManager.dispatch('e', {}, { immediate: true })
    const id = deliveries[0]!.id
    await WebhookManager.deliverNow(id)
    await WebhookManager.deliverNow(id)
    expect((await WebhookManager.store.getDelivery(id))?.status).toBe('dead')

    const beforeReplay = queuePushes.length
    await WebhookManager.replay(id)
    expect((await WebhookManager.store.getDelivery(id))?.status).toBe('pending')
    expect(queuePushes.length).toBe(beforeReplay + 1)
  })

  test('handles network errors as failures', async () => {
    installFetch(() => { throw new Error('connection refused') })
    await WebhookManager.createEndpoint({
      url: 'https://example.com/hook', secret: 's', events: ['e'],
    })
    const { deliveries } = await WebhookManager.dispatch('e', {}, { immediate: true })
    const final = await WebhookManager.store.getDelivery(deliveries[0]!.id)
    expect(final?.status).toBe('pending')
    expect(final?.lastError).toContain('connection refused')
  })
})
