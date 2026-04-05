import { inject } from '@strav/kernel'
import { Configuration } from '@strav/kernel'
import { Database } from '@strav/database'
import type { NotificationChannel, NotificationConfig, EventNotificationBinding } from './types.ts'
import { EmailChannel } from './channels/email_channel.ts'
import { DatabaseChannel } from './channels/database_channel.ts'
import { WebhookChannel } from './channels/webhook_channel.ts'
import { DiscordChannel } from './channels/discord_channel.ts'
import { ConfigurationError } from '@strav/kernel'

/**
 * Central notification configuration hub.
 *
 * Resolved once via the DI container — reads the notification config,
 * registers built-in channels, and provides an event-to-notification registry.
 *
 * @example
 * app.singleton(NotificationManager)
 * app.resolve(NotificationManager)
 * await NotificationManager.ensureTable()
 *
 * // Register a custom channel
 * NotificationManager.useChannel(new SlackChannel())
 */
@inject
export default class NotificationManager {
  private static _db: Database
  private static _config: NotificationConfig
  private static _channels = new Map<string, NotificationChannel>()
  private static _eventMap = new Map<string, EventNotificationBinding[]>()

  constructor(db: Database, config: Configuration) {
    NotificationManager._db = db
    NotificationManager._config = {
      channels: config.get('notification.channels', ['database']) as string[],
      queue: config.get('notification.queue', 'default') as string,
      webhooks: config.get('notification.webhooks', {}) as Record<
        string,
        { url: string; headers?: Record<string, string> }
      >,
      discord: config.get('notification.discord', {}) as Record<string, string>,
    }

    // Register built-in channels
    NotificationManager._channels.set('email', new EmailChannel())
    NotificationManager._channels.set('database', new DatabaseChannel())
    NotificationManager._channels.set('webhook', new WebhookChannel(NotificationManager._config))
    NotificationManager._channels.set('discord', new DiscordChannel(NotificationManager._config))
  }

  static get db(): Database {
    if (!NotificationManager._db) {
      throw new Error('NotificationManager not configured. Resolve it through the container first.')
    }
    return NotificationManager._db
  }

  static get config(): NotificationConfig {
    return NotificationManager._config
  }

  /** Get a registered channel by name. */
  static channel(name: string): NotificationChannel {
    const ch = NotificationManager._channels.get(name)
    if (!ch) throw new ConfigurationError(`Unknown notification channel: ${name}`)
    return ch
  }

  /** Register a custom notification channel (or replace a built-in one). */
  static useChannel(channel: NotificationChannel): void {
    NotificationManager._channels.set(channel.name, channel)
  }

  /** Create the _strav_notifications table if it doesn't exist. */
  static async ensureTable(): Promise<void> {
    const sql = NotificationManager.db.sql

    await sql`
      CREATE TABLE IF NOT EXISTS "_strav_notifications" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "notifiable_type" VARCHAR(255) NOT NULL,
        "notifiable_id" VARCHAR(255) NOT NULL,
        "type" VARCHAR(255) NOT NULL,
        "data" JSONB NOT NULL DEFAULT '{}',
        "read_at" TIMESTAMPTZ,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `

    await sql`
      CREATE INDEX IF NOT EXISTS "idx_strav_notifications_notifiable"
        ON "_strav_notifications" ("notifiable_type", "notifiable_id", "created_at" DESC)
    `

    await sql`
      CREATE INDEX IF NOT EXISTS "idx_strav_notifications_unread"
        ON "_strav_notifications" ("notifiable_type", "notifiable_id")
        WHERE "read_at" IS NULL
    `
  }

  /**
   * Register an event-to-notification mapping.
   *
   * @example
   * NotificationManager.on('task.assigned', {
   *   create: (payload) => new TaskAssignedNotification(payload.task, payload.assigner),
   *   recipients: (payload) => payload.assignee,
   * })
   */
  static on(event: string, binding: EventNotificationBinding): void {
    const existing = NotificationManager._eventMap.get(event) ?? []
    existing.push(binding)
    NotificationManager._eventMap.set(event, existing)
  }

  /** Expose the event map (used by wireEvents). */
  static eventBindings(): Map<string, EventNotificationBinding[]> {
    return NotificationManager._eventMap
  }

  /** Clear all state. For testing only. */
  static reset(): void {
    NotificationManager._channels.clear()
    NotificationManager._eventMap.clear()
  }
}
