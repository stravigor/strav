import NotificationManager from './notification_manager.ts'
import type { BaseNotification } from './base_notification.ts'
import type { Notifiable, NotificationRecord } from './types.ts'
import { Queue } from '@strav/queue'
import { Emitter } from '@strav/kernel'
import { Database } from '@strav/database'

/**
 * Send a notification to one or more recipients.
 *
 * @example
 * import { notify } from '@strav/signal/notification'
 *
 * await notify(user, new TaskAssignedNotification(task, assigner))
 * await notify([user1, user2], new InvoicePaidNotification(invoice))
 */
export async function notify(
  notifiable: Notifiable | Notifiable[],
  notification: BaseNotification
): Promise<void> {
  const recipients = Array.isArray(notifiable) ? notifiable : [notifiable]

  for (const recipient of recipients) {
    if (notification.shouldQueue()) {
      const payload = notification.buildPayload(recipient)

      // Pre-resolve routing info so channels can deliver from the queue worker
      const routing: Record<string, string> = {}
      const email = recipient.routeNotificationForEmail?.()
      if (email) routing.email = email
      const webhook = recipient.routeNotificationForWebhook?.()
      if (webhook) routing.webhook = webhook
      const discord = recipient.routeNotificationForDiscord?.()
      if (discord) routing.discord = discord

      await Queue.push(
        'strav:send-notification',
        {
          notifiable: { id: recipient.notifiableId(), type: recipient.notifiableType() },
          routing,
          payload,
        },
        {
          queue: notification.queueOptions().queue ?? NotificationManager.config.queue,
          delay: notification.queueOptions().delay,
          attempts: notification.queueOptions().attempts,
        }
      )
    } else {
      await sendNow(recipient, notification)
    }
  }
}

/** Send a notification immediately (bypasses queue). */
async function sendNow(notifiable: Notifiable, notification: BaseNotification): Promise<void> {
  const payload = notification.buildPayload(notifiable)

  for (const channelName of payload.channels) {
    const channel = NotificationManager.channel(channelName)
    await channel.send(notifiable, payload)
  }
}

// ---------------------------------------------------------------------------
// In-app notification query helpers
// ---------------------------------------------------------------------------

/**
 * Notification query helper — convenience API for in-app notification reads.
 *
 * @example
 * import { notifications } from '@strav/signal/notification'
 *
 * const unread = await notifications.unread('user', userId)
 * await notifications.markAsRead(notificationId)
 * await notifications.markAllAsRead('user', userId)
 */
export const notifications = {
  /** Get all notifications for a notifiable, newest first. */
  async all(type: string, id: string | number, limit = 50): Promise<NotificationRecord[]> {
    const sql = Database.raw
    const rows = await sql`
      SELECT * FROM "_strav_notifications"
      WHERE "notifiable_type" = ${type} AND "notifiable_id" = ${String(id)}
      ORDER BY "created_at" DESC
      LIMIT ${limit}
    `
    return rows.map(hydrateNotification)
  },

  /** Get unread notifications for a notifiable. */
  async unread(type: string, id: string | number, limit = 50): Promise<NotificationRecord[]> {
    const sql = Database.raw
    const rows = await sql`
      SELECT * FROM "_strav_notifications"
      WHERE "notifiable_type" = ${type}
        AND "notifiable_id" = ${String(id)}
        AND "read_at" IS NULL
      ORDER BY "created_at" DESC
      LIMIT ${limit}
    `
    return rows.map(hydrateNotification)
  },

  /** Count unread notifications. */
  async unreadCount(type: string, id: string | number): Promise<number> {
    const sql = Database.raw
    const rows = await sql`
      SELECT COUNT(*)::int AS count FROM "_strav_notifications"
      WHERE "notifiable_type" = ${type}
        AND "notifiable_id" = ${String(id)}
        AND "read_at" IS NULL
    `
    return (rows[0] as Record<string, unknown>).count as number
  },

  /** Mark a single notification as read. */
  async markAsRead(id: string): Promise<void> {
    const sql = Database.raw
    await sql`
      UPDATE "_strav_notifications"
      SET "read_at" = NOW()
      WHERE "id" = ${id} AND "read_at" IS NULL
    `
  },

  /** Mark all notifications as read for a notifiable. */
  async markAllAsRead(type: string, id: string | number): Promise<void> {
    const sql = Database.raw
    await sql`
      UPDATE "_strav_notifications"
      SET "read_at" = NOW()
      WHERE "notifiable_type" = ${type}
        AND "notifiable_id" = ${String(id)}
        AND "read_at" IS NULL
    `
  },

  /** Delete a single notification. */
  async delete(id: string): Promise<void> {
    const sql = Database.raw
    await sql`DELETE FROM "_strav_notifications" WHERE "id" = ${id}`
  },

  /** Delete all notifications for a notifiable. */
  async deleteAll(type: string, id: string | number): Promise<void> {
    const sql = Database.raw
    await sql`
      DELETE FROM "_strav_notifications"
      WHERE "notifiable_type" = ${type} AND "notifiable_id" = ${String(id)}
    `
  },

  /**
   * Register the built-in queue handler for async notification delivery.
   * Call this in your app bootstrap after Queue and NotificationManager are configured.
   */
  registerQueueHandler(): void {
    Queue.handle('strav:send-notification', async (job: any) => {
      const { notifiable: ref, routing, payload } = job

      // Reconstruct a minimal Notifiable proxy with pre-resolved routing
      const notifiable: Notifiable = {
        notifiableId: () => ref.id,
        notifiableType: () => ref.type,
        routeNotificationForEmail: () => routing?.email ?? null,
        routeNotificationForWebhook: () => routing?.webhook ?? null,
        routeNotificationForDiscord: () => routing?.discord ?? null,
      }

      for (const channelName of payload.channels) {
        const channel = NotificationManager.channel(channelName)
        await channel.send(notifiable, payload)
      }
    })
  },

  /**
   * Wire event-to-notification mappings to the Emitter.
   * Call this once during bootstrap after registering all bindings via
   * {@link NotificationManager.on}.
   */
  wireEvents(): void {
    for (const [event, bindings] of NotificationManager.eventBindings()) {
      Emitter.on(event, async (eventPayload: any) => {
        for (const binding of bindings) {
          const notification = binding.create(eventPayload)
          const recipients = await binding.recipients(eventPayload)
          await notify(recipients, notification)
        }
      })
    }
  },
}

// ---------------------------------------------------------------------------
// Hydration
// ---------------------------------------------------------------------------

function hydrateNotification(row: Record<string, unknown>): NotificationRecord {
  return {
    id: row.id as string,
    notifiableType: row.notifiable_type as string,
    notifiableId: row.notifiable_id as string,
    type: row.type as string,
    data: (typeof row.data === 'string' ? JSON.parse(row.data) : row.data) as Record<
      string,
      unknown
    >,
    readAt: (row.read_at as Date) ?? null,
    createdAt: row.created_at as Date,
  }
}
