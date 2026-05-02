/** A recipient that can receive notifications. */
export interface Notifiable {
  /** Unique identifier for the notifiable entity. */
  notifiableId(): string | number
  /** Type discriminator (e.g., 'user', 'organization'). */
  notifiableType(): string
  /** Email address for the email channel. Returns null to skip email. */
  routeNotificationForEmail?(): string | null
  /** Webhook URL for the webhook channel. Returns null to skip. */
  routeNotificationForWebhook?(): string | null
  /** Discord webhook URL. Returns null to skip. */
  routeNotificationForDiscord?(): string | null
  /** WhatsApp recipient (E.164 phone). Returns null to skip. */
  routeNotificationForWhatsapp?(): string | null
  /** Messenger recipient PSID. Returns null to skip. */
  routeNotificationForMessenger?(): string | null
  /** LINE recipient (userId / groupId / roomId). Returns null to skip. */
  routeNotificationForLine?(): string | null
}

// -- Channel envelopes --------------------------------------------------------

/** Envelope produced by a notification for the email channel. */
export interface MailEnvelope {
  subject: string
  template?: string
  templateData?: Record<string, unknown>
  html?: string
  text?: string
  from?: string
  cc?: string | string[]
  bcc?: string | string[]
  replyTo?: string
}

/** Envelope produced by a notification for the database (in-app) channel. */
export interface DatabaseEnvelope {
  /** Notification type / category (e.g., 'task.assigned', 'invoice.paid'). */
  type: string
  /** Structured data stored as JSONB. */
  data: Record<string, unknown>
}

/** Envelope produced by a notification for the webhook channel. */
export interface WebhookEnvelope {
  /** JSON payload to POST. */
  payload: Record<string, unknown>
  /** Optional custom headers. */
  headers?: Record<string, string>
  /** Override the webhook URL from notifiable routing. */
  url?: string
}

/** Envelope produced by a notification for the Discord channel. */
export interface DiscordEnvelope {
  /** Plain text content. */
  content?: string
  /** Discord embed objects. */
  embeds?: DiscordEmbed[]
  /** Override the webhook URL from notifiable routing. */
  url?: string
}

export interface DiscordEmbed {
  title?: string
  description?: string
  url?: string
  color?: number
  fields?: { name: string; value: string; inline?: boolean }[]
  footer?: { text: string }
  timestamp?: string
}

// -- Channel interface --------------------------------------------------------

/** Envelope produced by a notification for an instant-messaging channel. */
export interface MessagingEnvelope {
  /** Plain text body. Optional when sending media-only. */
  text?: string
  /**
   * Media attachments. Loosely typed here to avoid a notification → messaging
   * dependency cycle; matches `MessagingMedia` from `@strav/signal/messaging`.
   */
  media?: {
    kind: 'image' | 'audio' | 'video' | 'file'
    url?: string
    mediaId?: string
    filename?: string
    contentType?: string
    caption?: string
  }[]
  /**
   * Provider-specific reply context (WhatsApp WAMID, LINE reply token).
   * See `MessagingMessage.replyTo` in `@strav/signal/messaging`.
   */
  replyTo?: string
}

/** Serializable envelope bundle built by BaseNotification. */
export interface NotificationPayload {
  notificationClass: string
  channels: string[]
  mail?: MailEnvelope
  database?: DatabaseEnvelope
  webhook?: WebhookEnvelope
  discord?: DiscordEnvelope
  whatsapp?: MessagingEnvelope
  messenger?: MessagingEnvelope
  line?: MessagingEnvelope
}

/**
 * Pluggable notification channel backend.
 * Implement this interface for custom channels.
 */
export interface NotificationChannel {
  readonly name: string
  send(notifiable: Notifiable, payload: NotificationPayload): Promise<void>
}

// -- Database records ---------------------------------------------------------

/** A stored in-app notification row. */
export interface NotificationRecord {
  id: string
  notifiableType: string
  notifiableId: string
  type: string
  data: Record<string, unknown>
  readAt: Date | null
  createdAt: Date
}

// -- Configuration ------------------------------------------------------------

export interface NotificationConfig {
  /** Default channels when a notification does not specify via(). */
  channels: string[]
  /** Queue name for async notifications. */
  queue: string
  /** Named webhook endpoints. */
  webhooks: Record<string, { url: string; headers?: Record<string, string> }>
  /** Named Discord webhook URLs. */
  discord: Record<string, string>
}

// -- Event binding ------------------------------------------------------------

export interface EventNotificationBinding {
  /** Factory that creates the notification from the event payload. */
  create: (payload: any) => import('./base_notification.ts').BaseNotification
  /** Resolves which notifiable(s) should receive this notification. */
  recipients: (payload: any) => Notifiable | Notifiable[] | Promise<Notifiable | Notifiable[]>
}
