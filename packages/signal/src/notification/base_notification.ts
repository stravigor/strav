import type {
  Notifiable,
  MailEnvelope,
  DatabaseEnvelope,
  WebhookEnvelope,
  DiscordEnvelope,
  MessagingEnvelope,
  NotificationPayload,
} from './types.ts'

/**
 * Base class for all notifications.
 *
 * Extend this class and implement `via()` plus at least one `toXxx()` method
 * to define how the notification should be delivered on each channel.
 *
 * @example
 * class TaskAssignedNotification extends BaseNotification {
 *   constructor(private task: Task, private assigner: User) { super() }
 *
 *   via() { return ['email', 'database'] }
 *
 *   toEmail(notifiable: Notifiable): MailEnvelope {
 *     return { subject: `Assigned: ${this.task.title}`, template: 'task-assigned', templateData: { ... } }
 *   }
 *
 *   toDatabase(): DatabaseEnvelope {
 *     return { type: 'task.assigned', data: { taskId: this.task.id } }
 *   }
 *
 *   shouldQueue() { return true }
 * }
 */
export abstract class BaseNotification {
  /** Which channels this notification should be sent on. */
  abstract via(notifiable: Notifiable): string[]

  /** Build the email envelope. */
  toEmail?(notifiable: Notifiable): MailEnvelope
  /** Build the database (in-app) envelope. */
  toDatabase?(notifiable: Notifiable): DatabaseEnvelope
  /** Build the webhook envelope. */
  toWebhook?(notifiable: Notifiable): WebhookEnvelope
  /** Build the Discord envelope. */
  toDiscord?(notifiable: Notifiable): DiscordEnvelope
  /** Build the WhatsApp envelope. */
  toWhatsapp?(notifiable: Notifiable): MessagingEnvelope
  /** Build the Messenger envelope. */
  toMessenger?(notifiable: Notifiable): MessagingEnvelope
  /** Build the LINE envelope. */
  toLine?(notifiable: Notifiable): MessagingEnvelope

  /** Whether this notification should be queued for async delivery. */
  shouldQueue(): boolean {
    return false
  }

  /** Queue options (queue name, delay in ms, max attempts). */
  queueOptions(): { queue?: string; delay?: number; attempts?: number } {
    return {}
  }

  /** Build a serializable payload containing all channel envelopes. */
  buildPayload(notifiable: Notifiable): NotificationPayload {
    return {
      notificationClass: this.constructor.name,
      channels: this.via(notifiable),
      mail: this.toEmail?.(notifiable),
      database: this.toDatabase?.(notifiable),
      webhook: this.toWebhook?.(notifiable),
      discord: this.toDiscord?.(notifiable),
      whatsapp: this.toWhatsapp?.(notifiable),
      messenger: this.toMessenger?.(notifiable),
      line: this.toLine?.(notifiable),
    }
  }
}
