import type { NotificationChannel, Notifiable, NotificationPayload } from '../types.ts'
import { Database } from '@strav/database'

/**
 * Stores notifications in the `_strav_notifications` table.
 *
 * The database channel enables in-app notification features
 * (unread badges, notification feeds, etc.).
 */
export class DatabaseChannel implements NotificationChannel {
  readonly name = 'database'

  async send(notifiable: Notifiable, payload: NotificationPayload): Promise<void> {
    const envelope = payload.database
    if (!envelope) return

    const sql = Database.raw

    await sql`
      INSERT INTO "_strav_notifications"
        ("notifiable_type", "notifiable_id", "type", "data")
      VALUES (
        ${notifiable.notifiableType()},
        ${String(notifiable.notifiableId())},
        ${envelope.type},
        ${JSON.stringify(envelope.data)}
      )
    `
  }
}
