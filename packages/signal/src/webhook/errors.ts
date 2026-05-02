import { StravError } from '@strav/kernel'

export class WebhookError extends StravError {}

export class EndpointNotFoundError extends WebhookError {
  constructor(public readonly endpointId: string) {
    super(`Webhook endpoint not found: ${endpointId}`)
  }
}

export class DeliveryNotFoundError extends WebhookError {
  constructor(public readonly deliveryId: string) {
    super(`Webhook delivery not found: ${deliveryId}`)
  }
}
