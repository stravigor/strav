import type { FlexContainer } from './flex/types.ts'

/**
 * Top-level configuration consumed by LineManager.
 *
 * Read from `line.*` in the app's Configuration. The channelAccessToken is
 * the same value @strav/signal's LineTransport uses — both packages can be
 * configured from the same secret.
 */
export interface LineConfig {
  /** Channel access token (long-lived) issued by the LINE Developers console. */
  channelAccessToken: string
  /** Channel secret used to verify inbound X-Line-Signature. */
  channelSecret?: string
  /** Override LINE Messaging API base URL. Default: 'https://api.line.me' */
  baseUrl?: string
  /** Override LINE data API base URL (content download). Default: 'https://api-data.line.me' */
  dataBaseUrl?: string
  /** LIFF configuration (optional — only required for LIFF token verification). */
  liff?: LiffConfig
  /** LINE Login configuration (optional — only required for OAuth flows). */
  login?: LineLoginConfig
}

export interface LiffConfig {
  /**
   * LIFF channel ID. Used as the audience claim when verifying ID tokens
   * minted by `liff.getIDToken()` inside a LIFF browser.
   */
  channelId: string
}

export interface LineLoginConfig {
  /** LINE Login channel ID. */
  channelId: string
  /** LINE Login channel secret. */
  channelSecret: string
}

/**
 * A recipient of a LINE outbound message.
 *
 * LINE accepts user IDs, group IDs, and room IDs as `to` targets. The LINE
 * platform does not distinguish them at the API level — the same value flows
 * through for any source type.
 */
export type LineRecipient = string

/**
 * Action attached to a Quick Reply item or Flex button.
 *
 * The same Action shape is reused across Quick Replies, Flex buttons, and
 * Rich Menu areas. Only a subset is implemented here — extend as needed.
 *
 * @see https://developers.line.biz/en/reference/messaging-api/#action-objects
 */
export type LineAction =
  | MessageAction
  | PostbackAction
  | UriAction
  | DatetimePickerAction
  | CameraAction
  | CameraRollAction
  | LocationAction

export interface MessageAction {
  type: 'message'
  label?: string
  text: string
}

export interface PostbackAction {
  type: 'postback'
  label?: string
  data: string
  displayText?: string
  inputOption?: 'closeRichMenu' | 'openRichMenu' | 'openKeyboard' | 'openVoice'
  fillInText?: string
}

export interface UriAction {
  type: 'uri'
  label?: string
  uri: string
  altUri?: { desktop?: string }
}

export interface DatetimePickerAction {
  type: 'datetimepicker'
  label?: string
  data: string
  mode: 'date' | 'time' | 'datetime'
  initial?: string
  max?: string
  min?: string
}

export interface CameraAction {
  type: 'camera'
  label: string
}

export interface CameraRollAction {
  type: 'cameraRoll'
  label: string
}

export interface LocationAction {
  type: 'location'
  label: string
}

/**
 * Quick reply attached to any outbound LINE message.
 *
 * Max 13 items. Each item renders as a button below the message bubble.
 */
export interface QuickReply {
  items: QuickReplyItem[]
}

export interface QuickReplyItem {
  type: 'action'
  imageUrl?: string
  action: LineAction
}

/**
 * Sender identity override on a per-message basis (icon + display name).
 * Useful for keeping a single LINE OA but presenting different "bots" per
 * tenant or workflow.
 */
export interface Sender {
  name?: string
  iconUrl?: string
}

/**
 * A LINE outbound message. Union over the supported message types.
 *
 * This shape passes through directly to the Messaging API; transports and
 * builders compose values of this shape. Plain text and media values map
 * 1:1 to `@strav/signal`'s simpler `MessagingMessage` for cases where the
 * unified abstraction is enough.
 */
export type LineMessage =
  | TextMessage
  | StickerMessage
  | ImageMessage
  | VideoMessage
  | AudioMessage
  | LocationMessage
  | FlexMessage

interface BaseMessage {
  quickReply?: QuickReply
  sender?: Sender
}

export interface TextMessage extends BaseMessage {
  type: 'text'
  text: string
  /** Optional emoji substitutions; see LINE docs for $-marker syntax. */
  emojis?: Array<{ index: number; productId: string; emojiId: string }>
}

export interface StickerMessage extends BaseMessage {
  type: 'sticker'
  packageId: string
  stickerId: string
}

export interface ImageMessage extends BaseMessage {
  type: 'image'
  originalContentUrl: string
  previewImageUrl: string
}

export interface VideoMessage extends BaseMessage {
  type: 'video'
  originalContentUrl: string
  previewImageUrl: string
  trackingId?: string
}

export interface AudioMessage extends BaseMessage {
  type: 'audio'
  originalContentUrl: string
  /** Duration in milliseconds. */
  duration: number
}

export interface LocationMessage extends BaseMessage {
  type: 'location'
  title: string
  address: string
  latitude: number
  longitude: number
}

export interface FlexMessage extends BaseMessage {
  type: 'flex'
  /** Alternative text shown in chat lists and push notifications. Max 400 chars. */
  altText: string
  contents: FlexContainer
}

/** Hard limits enforced by the LINE Messaging API. */
export const LINE_LIMITS = {
  /** Maximum messages per /push, /reply, /multicast, /broadcast call. */
  MESSAGES_PER_REQUEST: 5,
  /** Maximum recipient IDs per /multicast call. */
  MULTICAST_RECIPIENTS: 500,
  /** Maximum text message length, characters. */
  TEXT_MAX: 5000,
  /** Maximum alt text length on a Flex message, characters. */
  ALT_TEXT_MAX: 400,
  /** Maximum quick reply items. */
  QUICK_REPLY_MAX: 13,
  /** Maximum size of a serialised Flex bubble, bytes. */
  FLEX_BUBBLE_BYTES: 30_000,
  /** Maximum bubbles in a Flex carousel. */
  FLEX_CAROUSEL_BUBBLES: 12,
} as const
