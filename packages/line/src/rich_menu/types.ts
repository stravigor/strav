import type { LineAction } from '../types.ts'

/**
 * Rich Menu structural types.
 *
 * Mirrors https://developers.line.biz/en/reference/messaging-api/#rich-menu
 *
 * LINE accepts two canonical image sizes: 2500×1686 (large) and 2500×843
 * (compact). Custom dimensions are also allowed in the documented ranges
 * but most apps stick to the canonical pair.
 */
export interface RichMenuSize {
  width: number
  height: number
}

export const RICH_MENU_SIZE_LARGE: RichMenuSize = { width: 2500, height: 1686 }
export const RICH_MENU_SIZE_COMPACT: RichMenuSize = { width: 2500, height: 843 }

export interface RichMenuArea {
  bounds: { x: number; y: number; width: number; height: number }
  action: LineAction
}

/**
 * Request shape for POST /v2/bot/richmenu. `name` is internal-only; the
 * label users actually see on the chat bar is `chatBarText` (≤ 14 chars).
 */
export interface CreateRichMenuRequest {
  size: RichMenuSize
  selected: boolean
  name: string
  chatBarText: string
  areas: RichMenuArea[]
}

export interface RichMenuResponse extends CreateRichMenuRequest {
  richMenuId: string
}

/**
 * Hard limits enforced by the LINE Rich Menu API.
 */
export const RICH_MENU_LIMITS = {
  /** Max bytes of the rich-menu image upload. */
  IMAGE_BYTES: 1_024 * 1024,
  /** Max chars in the internal `name`. */
  NAME_MAX: 300,
  /** Max chars in the chat-bar label. */
  CHAT_BAR_TEXT_MAX: 14,
} as const
