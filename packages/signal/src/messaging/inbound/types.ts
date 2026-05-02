import type { InboundWebhookInput } from '../../mail/inbound/types.ts'
import type { MessagingMedia, MessagingProviderName } from '../types.ts'

/**
 * Canonical inbound message shape, normalized across providers.
 *
 * IM webhooks are batchy by nature: a single HTTP delivery may carry many
 * events (multiple messages, status updates, postbacks). Parsers return an
 * array; consumers iterate. Non-message events (delivery receipts, read
 * acks, postbacks) are dropped from the array — capture them via the raw
 * payload if needed.
 */
export interface ParsedInboundMessage {
  provider: MessagingProviderName
  /**
   * Provider's stable conversation/thread identifier:
   * - WhatsApp: the sender's WhatsApp ID (E.164 without leading '+').
   * - Messenger: the user's Page-Scoped ID (PSID).
   * - LINE: the source ID — `userId`, `groupId`, or `roomId`.
   */
  conversationId: string
  /** The sender's provider-side user ID (== conversationId for 1:1 chats). */
  fromUserId: string
  /** Display name when the provider includes it inline (LINE webhooks include profile only on demand). */
  fromName?: string
  text?: string
  media: MessagingMedia[]
  /** Provider's message ID — opaque, used for de-dup and replies. */
  providerMessageId: string
  /**
   * Reply token (LINE only) — single-use, ~30s TTL. Pass it as
   * `MessagingMessage.replyTo` to use the /reply endpoint. Empty for
   * WhatsApp and Messenger.
   */
  replyToken?: string
  receivedAt: Date
  /** Original event payload, preserved for callers that need provider-specific fields. */
  raw: unknown
}

/** Pluggable inbound IM webhook parser. */
export interface InboundMessageParser {
  parse(input: InboundWebhookInput): Promise<ParsedInboundMessage[]>
}

export type InboundMessageHandler = (
  message: ParsedInboundMessage
) => void | Promise<void>
