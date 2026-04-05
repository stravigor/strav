import { ExternalServiceError } from '@strav/kernel'
import type {
  NotificationChannel,
  Notifiable,
  NotificationPayload,
  NotificationConfig,
} from '../types.ts'

/**
 * Delivers notifications via HTTP POST to a webhook URL.
 *
 * URL resolution order:
 * 1. `WebhookEnvelope.url` (per-notification override)
 * 2. `notifiable.routeNotificationForWebhook()` (per-recipient)
 * 3. Config webhooks `default` entry
 */
export class WebhookChannel implements NotificationChannel {
  readonly name = 'webhook'

  constructor(private config: NotificationConfig) {}

  async send(notifiable: Notifiable, payload: NotificationPayload): Promise<void> {
    const envelope = payload.webhook
    if (!envelope) return

    const url =
      envelope.url ??
      notifiable.routeNotificationForWebhook?.() ??
      this.config.webhooks?.default?.url ??
      null

    if (!url) return

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.config.webhooks?.default?.headers,
      ...envelope.headers,
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(envelope.payload),
    })

    if (!response.ok) {
      throw new ExternalServiceError('Webhook', response.status, await response.text())
    }
  }
}
