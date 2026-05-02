import { inject, ConfigurationError, Configuration } from '@strav/kernel'
import { Database } from '@strav/database'
import { Queue } from '@strav/queue'
import { DatabaseWebhookStore } from './storage/database_store.ts'
import { MemoryWebhookStore } from './storage/memory_store.ts'
import { attemptDelivery } from './delivery.ts'
import { nextDelayMs, shouldDeadLetter } from './retry_policy.ts'
import type {
  DispatchOptions,
  DispatchResult,
  WebhookConfig,
  WebhookDelivery,
  WebhookEndpoint,
  WebhookEndpointInput,
  WebhookEndpointPatch,
  WebhookStore,
} from './types.ts'

const QUEUE_JOB_NAME = 'strav:webhook-deliver'

interface DeliveryJob {
  deliveryId: string
}

/**
 * Central webhook subsystem hub.
 *
 * Owns the active store, the runtime config, and the queue handler that
 * processes delivery jobs. `dispatch()` fans out an event to every
 * registered endpoint that has subscribed to its name (or `'*'`); each fan
 * out creates a delivery row and schedules a job. The job worker calls
 * {@link attemptDelivery}, updates the delivery, and either completes or
 * re-enqueues itself with the configured backoff.
 */
@inject
export default class WebhookManager {
  private static _store: WebhookStore
  private static _config: WebhookConfig

  constructor(config: Configuration) {
    WebhookManager._config = {
      driver: config.get('webhook.driver', 'database') as string,
      maxAttempts: config.get('webhook.maxAttempts', 8) as number,
      baseDelayMs: config.get('webhook.baseDelayMs', 30_000) as number,
      factor: config.get('webhook.factor', 2) as number,
      ceilingMs: config.get('webhook.ceilingMs', 12 * 60 * 60 * 1000) as number,
      jitter: config.get('webhook.jitter', 0.2) as number,
      responseBodyLimit: config.get('webhook.responseBodyLimit', 65_536) as number,
      fetchTimeoutMs: config.get('webhook.fetchTimeoutMs', 15_000) as number,
    }
    WebhookManager._store = WebhookManager.createStore(WebhookManager._config.driver)
  }

  private static createStore(driver: string): WebhookStore {
    switch (driver) {
      case 'database':
        return new DatabaseWebhookStore(Database.raw)
      case 'memory':
        return new MemoryWebhookStore()
      default:
        throw new ConfigurationError(
          `Unknown webhook driver: ${driver}. Use WebhookManager.useStore() for custom stores.`
        )
    }
  }

  static get store(): WebhookStore {
    if (!WebhookManager._store) {
      throw new ConfigurationError(
        'WebhookManager not configured. Resolve it through the container first.'
      )
    }
    return WebhookManager._store
  }

  static get config(): WebhookConfig {
    return WebhookManager._config
  }

  static useStore(store: WebhookStore): void {
    WebhookManager._store = store
  }

  static async ensureTables(): Promise<void> {
    await WebhookManager.store.ensureTables()
  }

  // -- Endpoint CRUD ----------------------------------------------------------

  static createEndpoint(input: WebhookEndpointInput): Promise<WebhookEndpoint> {
    return WebhookManager.store.createEndpoint(input)
  }
  static getEndpoint(id: string): Promise<WebhookEndpoint | null> {
    return WebhookManager.store.getEndpoint(id)
  }
  static listEndpoints(): Promise<WebhookEndpoint[]> {
    return WebhookManager.store.listEndpoints()
  }
  static updateEndpoint(id: string, patch: WebhookEndpointPatch): Promise<WebhookEndpoint | null> {
    return WebhookManager.store.updateEndpoint(id, patch)
  }
  static deleteEndpoint(id: string): Promise<void> {
    return WebhookManager.store.deleteEndpoint(id)
  }

  // -- Dispatch ---------------------------------------------------------------

  /**
   * Fan out an event to all matching endpoints. Each match produces a
   * delivery row; immediate=false (default) queues the delivery via @strav/queue,
   * immediate=true performs the delivery synchronously and returns the result.
   */
  static async dispatch(
    event: string,
    payload: unknown,
    opts: DispatchOptions = {}
  ): Promise<DispatchResult> {
    const endpoints = opts.endpointId
      ? await singleton(WebhookManager.store.getEndpoint(opts.endpointId))
      : await WebhookManager.store.endpointsForEvent(event)

    const deliveries: WebhookDelivery[] = []
    for (const endpoint of endpoints) {
      const delivery = await WebhookManager.store.createDelivery({
        endpointId: endpoint.id,
        event,
        payload,
      })
      deliveries.push(delivery)
      if (opts.immediate) {
        await WebhookManager.deliverNow(delivery.id)
      } else {
        await Queue.push<DeliveryJob>(QUEUE_JOB_NAME, { deliveryId: delivery.id })
      }
    }
    return { deliveries }
  }

  /**
   * Re-enqueue a delivery — typically used to retry a delivery that hit the
   * dead-letter state. Resets `nextRetryAt`, leaves attempt count alone so
   * the operator can audit how many retries it took to recover.
   */
  static async replay(deliveryId: string): Promise<void> {
    const delivery = await WebhookManager.store.getDelivery(deliveryId)
    if (!delivery) return
    await WebhookManager.store.updateDelivery(deliveryId, {
      status: 'pending',
      nextRetryAt: undefined,
    })
    await Queue.push<DeliveryJob>(QUEUE_JOB_NAME, { deliveryId })
  }

  /**
   * Execute a delivery now and update its row. Used by the queue worker,
   * by `dispatch({ immediate: true })`, and by tests. Returns the updated
   * delivery (terminal status or pending with `nextRetryAt`).
   */
  static async deliverNow(deliveryId: string): Promise<WebhookDelivery | null> {
    const delivery = await WebhookManager.store.getDelivery(deliveryId)
    if (!delivery) return null
    const endpoint = await WebhookManager.store.getEndpoint(delivery.endpointId)
    if (!endpoint || !endpoint.active) {
      return WebhookManager.store.updateDelivery(deliveryId, {
        status: 'failed',
        attempts: delivery.attempts + 1,
        lastError: 'Endpoint missing or inactive',
        nextRetryAt: undefined,
      })
    }
    const outcome = await attemptDelivery(endpoint, delivery, WebhookManager._config)
    const attempts = delivery.attempts + 1
    if (outcome.ok) {
      return WebhookManager.store.updateDelivery(deliveryId, {
        status: 'delivered',
        attempts,
        responseStatus: outcome.status,
        responseBody: outcome.responseBody,
        deliveredAt: new Date(),
        nextRetryAt: undefined,
        lastError: undefined,
      })
    }
    if (shouldDeadLetter(attempts, WebhookManager._config)) {
      return WebhookManager.store.updateDelivery(deliveryId, {
        status: 'dead',
        attempts,
        responseStatus: outcome.status,
        responseBody: outcome.responseBody,
        lastError: outcome.error,
        nextRetryAt: undefined,
      })
    }
    const delayMs = nextDelayMs(attempts, WebhookManager._config)
    const nextRetryAt = new Date(Date.now() + delayMs)
    const updated = await WebhookManager.store.updateDelivery(deliveryId, {
      status: 'pending',
      attempts,
      responseStatus: outcome.status,
      responseBody: outcome.responseBody,
      lastError: outcome.error,
      nextRetryAt,
    })
    await Queue.push<DeliveryJob>(QUEUE_JOB_NAME, { deliveryId }, { delay: delayMs })
    return updated
  }

  /** Register the queue handler that processes delivery jobs. Idempotent. */
  static registerQueueHandler(): void {
    Queue.handle<DeliveryJob>(QUEUE_JOB_NAME, async job => {
      await WebhookManager.deliverNow(job.deliveryId)
    })
  }

  static reset(): void {
    if (WebhookManager._store && 'reset' in WebhookManager._store) {
      void WebhookManager._store.reset()
    }
  }
}

async function singleton<T>(promise: Promise<T | null>): Promise<T[]> {
  const value = await promise
  return value ? [value] : []
}
