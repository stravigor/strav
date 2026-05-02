import type {
  WebhookDelivery,
  WebhookDeliveryStatus,
  WebhookEndpoint,
  WebhookEndpointInput,
  WebhookEndpointPatch,
  WebhookStore,
} from '../types.ts'

function uuid(): string {
  return crypto.randomUUID()
}

/**
 * In-memory webhook store. For tests and short-lived processes — endpoints
 * and deliveries are lost when the process exits. Same semantics as the
 * database store.
 */
export class MemoryWebhookStore implements WebhookStore {
  readonly name = 'memory'
  private endpoints = new Map<string, WebhookEndpoint>()
  private deliveries = new Map<string, WebhookDelivery>()

  async ensureTables(): Promise<void> {}

  async createEndpoint(input: WebhookEndpointInput): Promise<WebhookEndpoint> {
    const ep: WebhookEndpoint = {
      id: uuid(),
      url: input.url,
      secret: input.secret,
      events: [...input.events],
      active: input.active ?? true,
      description: input.description,
      createdAt: new Date(),
    }
    this.endpoints.set(ep.id, ep)
    return ep
  }

  async getEndpoint(id: string): Promise<WebhookEndpoint | null> {
    return this.endpoints.get(id) ?? null
  }

  async listEndpoints(): Promise<WebhookEndpoint[]> {
    return [...this.endpoints.values()]
  }

  async updateEndpoint(
    id: string,
    patch: WebhookEndpointPatch
  ): Promise<WebhookEndpoint | null> {
    const existing = this.endpoints.get(id)
    if (!existing) return null
    const updated: WebhookEndpoint = {
      ...existing,
      ...patch,
      events: patch.events ? [...patch.events] : existing.events,
    }
    this.endpoints.set(id, updated)
    return updated
  }

  async deleteEndpoint(id: string): Promise<void> {
    this.endpoints.delete(id)
  }

  async endpointsForEvent(event: string): Promise<WebhookEndpoint[]> {
    return [...this.endpoints.values()].filter(
      ep => ep.active && (ep.events.includes('*') || ep.events.includes(event))
    )
  }

  async createDelivery(input: {
    endpointId: string
    event: string
    payload: unknown
  }): Promise<WebhookDelivery> {
    const delivery: WebhookDelivery = {
      id: uuid(),
      endpointId: input.endpointId,
      event: input.event,
      payload: input.payload,
      status: 'pending',
      attempts: 0,
      signedAt: new Date(),
    }
    this.deliveries.set(delivery.id, delivery)
    return delivery
  }

  async getDelivery(id: string): Promise<WebhookDelivery | null> {
    return this.deliveries.get(id) ?? null
  }

  async updateDelivery(
    id: string,
    patch: Partial<Omit<WebhookDelivery, 'id' | 'endpointId' | 'event' | 'payload'>>
  ): Promise<WebhookDelivery | null> {
    const existing = this.deliveries.get(id)
    if (!existing) return null
    const updated = { ...existing, ...patch }
    this.deliveries.set(id, updated)
    return updated
  }

  async forEndpoint(
    endpointId: string,
    opts?: { status?: WebhookDeliveryStatus; limit?: number }
  ): Promise<WebhookDelivery[]> {
    let result = [...this.deliveries.values()].filter(d => d.endpointId === endpointId)
    if (opts?.status) result = result.filter(d => d.status === opts.status)
    result.sort((a, b) => b.signedAt.getTime() - a.signedAt.getTime())
    if (opts?.limit !== undefined) result = result.slice(0, opts.limit)
    return result
  }

  async reset(): Promise<void> {
    this.endpoints.clear()
    this.deliveries.clear()
  }
}
