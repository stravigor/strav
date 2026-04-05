import { ExternalServiceError } from '@strav/kernel'
import type {
  NotificationChannel,
  Notifiable,
  NotificationPayload,
  NotificationConfig,
} from '../types.ts'

/**
 * Delivers notifications via Discord webhook.
 *
 * URL resolution order:
 * 1. `DiscordEnvelope.url` (per-notification override)
 * 2. `notifiable.routeNotificationForDiscord()` (per-recipient)
 * 3. Config discord `default` entry
 */
export class DiscordChannel implements NotificationChannel {
  readonly name = 'discord'

  constructor(private config: NotificationConfig) {}

  async send(notifiable: Notifiable, payload: NotificationPayload): Promise<void> {
    const envelope = payload.discord
    if (!envelope) return

    const url =
      envelope.url ??
      notifiable.routeNotificationForDiscord?.() ??
      this.config.discord?.default ??
      null

    if (!url) return

    const body: Record<string, unknown> = {}
    if (envelope.content) body.content = envelope.content
    if (envelope.embeds?.length) body.embeds = envelope.embeds

    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })

    if (!response.ok) {
      throw new ExternalServiceError('Discord', response.status, await response.text())
    }
  }
}
