import type {
  NotificationChannel,
  Notifiable,
  NotificationPayload,
} from '../../notification/types.ts'
import MessagingManager from '../messaging_manager.ts'
import type { MessagingMessage, MessagingProviderName } from '../types.ts'

type SupportedProvider = Extract<MessagingProviderName, 'whatsapp' | 'messenger' | 'line'>

/**
 * Delivers notifications via an instant-messaging provider.
 *
 * One instance per provider is registered with the NotificationManager so
 * that `BaseNotification.via()` can name 'whatsapp' / 'messenger' / 'line'
 * directly. Each instance reads its own envelope from the payload, looks up
 * the per-provider route on the notifiable, and dispatches through the
 * MessagingManager.
 */
export class MessagingChannel implements NotificationChannel {
  readonly name: SupportedProvider

  constructor(provider: SupportedProvider) {
    this.name = provider
  }

  async send(notifiable: Notifiable, payload: NotificationPayload): Promise<void> {
    const envelope = payload[this.name]
    if (!envelope) return

    const to = this.resolveRoute(notifiable)
    if (!to) return

    const message: MessagingMessage = {
      to,
      text: envelope.text,
      media: envelope.media,
      replyTo: envelope.replyTo,
    }

    await MessagingManager.driver(this.name).send(message)
  }

  private resolveRoute(notifiable: Notifiable): string | null {
    switch (this.name) {
      case 'whatsapp':
        return notifiable.routeNotificationForWhatsapp?.() ?? null
      case 'messenger':
        return notifiable.routeNotificationForMessenger?.() ?? null
      case 'line':
        return notifiable.routeNotificationForLine?.() ?? null
    }
  }
}
