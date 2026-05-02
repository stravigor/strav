import WebhookManager from './webhook_manager.ts'
import type {
  DispatchOptions,
  DispatchResult,
  WebhookDelivery,
  WebhookDeliveryStatus,
  WebhookEndpoint,
  WebhookEndpointInput,
  WebhookEndpointPatch,
} from './types.ts'

/**
 * Webhook helper — primary application API.
 *
 * @example
 * import { webhook } from '@strav/signal/webhook'
 *
 * const endpoint = await webhook.endpoints.create({
 *   url: 'https://customer.example/hooks/leads',
 *   secret: 'wh_secret_xyz',
 *   events: ['lead.created', 'lead.updated'],
 * })
 *
 * await webhook.dispatch('lead.created', { id: leadId, email, score })
 *
 * // In bootstrap, register the queue handler that processes deliveries
 * webhook.registerQueueHandler()
 */
export const webhook = {
  endpoints: {
    create(input: WebhookEndpointInput): Promise<WebhookEndpoint> {
      return WebhookManager.createEndpoint(input)
    },
    get(id: string): Promise<WebhookEndpoint | null> {
      return WebhookManager.getEndpoint(id)
    },
    list(): Promise<WebhookEndpoint[]> {
      return WebhookManager.listEndpoints()
    },
    update(id: string, patch: WebhookEndpointPatch): Promise<WebhookEndpoint | null> {
      return WebhookManager.updateEndpoint(id, patch)
    },
    delete(id: string): Promise<void> {
      return WebhookManager.deleteEndpoint(id)
    },
  },

  deliveries: {
    forEndpoint(
      endpointId: string,
      opts?: { status?: WebhookDeliveryStatus; limit?: number }
    ): Promise<WebhookDelivery[]> {
      return WebhookManager.store.forEndpoint(endpointId, opts)
    },
    get(id: string): Promise<WebhookDelivery | null> {
      return WebhookManager.store.getDelivery(id)
    },
  },

  dispatch(event: string, payload: unknown, opts?: DispatchOptions): Promise<DispatchResult> {
    return WebhookManager.dispatch(event, payload, opts ?? {})
  },

  replay(deliveryId: string): Promise<void> {
    return WebhookManager.replay(deliveryId)
  },

  deliverNow(deliveryId: string): Promise<WebhookDelivery | null> {
    return WebhookManager.deliverNow(deliveryId)
  },

  registerQueueHandler(): void {
    WebhookManager.registerQueueHandler()
  },
}
