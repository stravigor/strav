import { ServiceProvider } from '@strav/kernel'
import type { Application } from '@strav/kernel'
import MessagingManager from '../messaging/messaging_manager.ts'
import NotificationManager from '../notification/notification_manager.ts'
import { MessagingChannel } from '../messaging/channels/messaging_channel.ts'

export interface MessagingProviderOptions {
  /**
   * Whether to register WhatsApp/Messenger/LINE channels with the
   * NotificationManager so `BaseNotification.via()` can name them. Default: `true`.
   * Has no effect when @strav/signal/notification is not bootstrapped.
   */
  registerNotificationChannels?: boolean
}

export default class MessagingProvider extends ServiceProvider {
  readonly name = 'messaging'
  override readonly dependencies = ['config']

  constructor(private options?: MessagingProviderOptions) {
    super()
  }

  override register(app: Application): void {
    app.singleton(MessagingManager)
  }

  override boot(app: Application): void {
    app.resolve(MessagingManager)

    if (this.options?.registerNotificationChannels !== false) {
      // NotificationManager is optional — only wire channels when it's present.
      try {
        app.resolve(NotificationManager)
        NotificationManager.useChannel(new MessagingChannel('whatsapp'))
        NotificationManager.useChannel(new MessagingChannel('messenger'))
        NotificationManager.useChannel(new MessagingChannel('line'))
      } catch {
        // NotificationManager not registered — skip silently.
      }
    }
  }
}
