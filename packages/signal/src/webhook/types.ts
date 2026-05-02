/** A subscriber endpoint registered with the webhook system. */
export interface WebhookEndpoint {
  id: string
  url: string
  /** Shared with the customer; used as HMAC key for `X-Strav-Signature`. */
  secret: string
  /** Subscribed event names; `'*'` matches all events. */
  events: string[]
  active: boolean
  description?: string
  createdAt: Date
}

/** Delivery attempt status. */
export type WebhookDeliveryStatus = 'pending' | 'delivered' | 'failed' | 'dead'

/** A single delivery attempt (one row per dispatched event per endpoint). */
export interface WebhookDelivery {
  id: string
  endpointId: string
  event: string
  payload: unknown
  status: WebhookDeliveryStatus
  attempts: number
  lastError?: string
  responseStatus?: number
  responseBody?: string
  signedAt: Date
  deliveredAt?: Date
  nextRetryAt?: Date
}

export interface WebhookConfig {
  /** Driver name. Built-ins: 'database', 'memory'. */
  driver: string
  /** Max delivery attempts before marking 'dead'. Default: 8. */
  maxAttempts: number
  /** Base retry delay in ms. Default: 30000. */
  baseDelayMs: number
  /** Exponential factor between attempts. Default: 2. */
  factor: number
  /** Ceiling on the per-attempt delay in ms. Default: 12 hours. */
  ceilingMs: number
  /** Random jitter ratio applied to the computed delay (e.g. 0.2 → ±20%). Default: 0.2. */
  jitter: number
  /** Truncate stored response bodies to this many bytes. Default: 65536. */
  responseBodyLimit: number
  /** Connect/response timeout in ms applied to each delivery fetch. Default: 15000. */
  fetchTimeoutMs: number
}

export interface WebhookEndpointInput {
  url: string
  secret: string
  events: string[]
  active?: boolean
  description?: string
}

export interface WebhookEndpointPatch {
  url?: string
  secret?: string
  events?: string[]
  active?: boolean
  description?: string
}

export interface DispatchOptions {
  /** Force-target a specific endpoint id; otherwise fans out to all matching endpoints. */
  endpointId?: string
  /** Skip the queue and deliver immediately (synchronous). Default: false. */
  immediate?: boolean
}

export interface DispatchResult {
  /** One delivery row per matched endpoint. */
  deliveries: WebhookDelivery[]
}

export interface WebhookStore {
  readonly name: string
  ensureTables(): Promise<void>

  // Endpoints
  createEndpoint(input: WebhookEndpointInput): Promise<WebhookEndpoint>
  getEndpoint(id: string): Promise<WebhookEndpoint | null>
  listEndpoints(): Promise<WebhookEndpoint[]>
  updateEndpoint(id: string, patch: WebhookEndpointPatch): Promise<WebhookEndpoint | null>
  deleteEndpoint(id: string): Promise<void>
  /** Endpoints subscribed to `event` (or `'*'`). */
  endpointsForEvent(event: string): Promise<WebhookEndpoint[]>

  // Deliveries
  createDelivery(input: {
    endpointId: string
    event: string
    payload: unknown
  }): Promise<WebhookDelivery>
  getDelivery(id: string): Promise<WebhookDelivery | null>
  updateDelivery(
    id: string,
    patch: Partial<Omit<WebhookDelivery, 'id' | 'endpointId' | 'event' | 'payload'>>
  ): Promise<WebhookDelivery | null>
  forEndpoint(
    endpointId: string,
    opts?: { status?: WebhookDeliveryStatus; limit?: number }
  ): Promise<WebhookDelivery[]>

  /** Test only. */
  reset(): Promise<void>
}

/** Headers attached to every outbound delivery request. */
export interface SignedHeaders {
  'X-Strav-Delivery': string
  'X-Strav-Event': string
  'X-Strav-Timestamp': string
  'X-Strav-Signature': string
  'Content-Type': 'application/json'
  'User-Agent': string
}
