/** Supported instant-messaging providers. */
export type MessagingProviderName = 'whatsapp' | 'messenger' | 'line' | 'log'

/** Kind of media payload attached to a message. */
export type MessagingMediaKind = 'image' | 'audio' | 'video' | 'file'

/**
 * Media payload attached to an outbound or inbound message.
 *
 * For outbound: pass `url` (a public URL the provider can fetch) OR `mediaId`
 * (an upload reference returned by a prior provider-specific media upload).
 * Providers that require uploads (WhatsApp) handle the choice internally.
 *
 * For inbound: parsers populate `url` when the provider returns a fetchable
 * media URL, otherwise `mediaId` (consumer code fetches via the provider's
 * media-download API using the bearer token).
 */
export interface MessagingMedia {
  kind: MessagingMediaKind
  url?: string
  mediaId?: string
  filename?: string
  contentType?: string
  caption?: string
}

/** Outbound message. */
export interface MessagingMessage {
  /** Recipient identifier — phone (WhatsApp E.164), PSID (Messenger), userId/groupId/roomId (LINE). */
  to: string
  /** Plain text body. Optional when sending media-only. */
  text?: string
  /** One or more media attachments. */
  media?: MessagingMedia[]
  /**
   * Provider-specific reply context.
   * - WhatsApp: the parent message's WAMID (sets `context.message_id`).
   * - LINE: the per-event reply token (sends via /v2/bot/message/reply
   *   instead of /push). Reply tokens are single-use and short-lived.
   * - Messenger: ignored (no native reply primitive).
   */
  replyTo?: string
}

/** Outbound result returned by a transport. */
export interface MessagingResult {
  /** Provider's stable identifier for the sent message. */
  providerMessageId?: string
  /** Original provider response, kept for callers that need provider-specific fields. */
  raw?: unknown
}

/**
 * Pluggable IM transport.
 * Implement this interface for custom providers.
 */
export interface MessagingTransport {
  readonly name: MessagingProviderName | string
  send(message: MessagingMessage): Promise<MessagingResult>
}

// -- Per-provider configs -----------------------------------------------------

export interface WhatsAppConfig {
  /** WhatsApp Business "phone number ID" (numeric, from Meta dashboard). */
  phoneNumberId: string
  /** Long-lived system-user access token. */
  accessToken: string
  /** App secret used to verify inbound X-Hub-Signature-256. */
  appSecret?: string
  /** Verify token configured on the webhook subscription (used by the GET handshake). */
  verifyToken?: string
  /** Override Graph API base URL. Default: 'https://graph.facebook.com/v20.0' */
  baseUrl?: string
}

export interface MessengerConfig {
  /** Page access token (long-lived) issued for the Facebook Page. */
  pageAccessToken: string
  /** App secret used to verify inbound X-Hub-Signature-256. */
  appSecret?: string
  /** Verify token configured on the webhook subscription. */
  verifyToken?: string
  /** Override Graph API base URL. Default: 'https://graph.facebook.com/v20.0' */
  baseUrl?: string
}

export interface LineConfig {
  /** Channel access token (long-lived). */
  channelAccessToken: string
  /** Channel secret used to verify inbound X-Line-Signature. */
  channelSecret?: string
  /** Override LINE Messaging API base URL. Default: 'https://api.line.me' */
  baseUrl?: string
}

export interface LogMessagingConfig {
  /** 'console' or a file path. */
  output: 'console' | string
}

// -- Top-level messaging config ----------------------------------------------

export interface MessagingConfig {
  /**
   * Default provider for `messaging.to(...)` / `messaging.send(...)` when no
   * `via` is given. Apps that route per-recipient may leave this on 'log'.
   */
  default: MessagingProviderName | string
  whatsapp: WhatsAppConfig
  messenger: MessengerConfig
  line: LineConfig
  log: LogMessagingConfig
}
