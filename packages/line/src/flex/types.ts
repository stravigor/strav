/**
 * LINE Flex Message AST.
 *
 * Mirrors the structure documented at
 * https://developers.line.biz/en/reference/messaging-api/#flex-message
 *
 * The AST is exhaustive enough to cover the layouts the brief calls for
 * (post-preview card with translation tabs, approval confirmation, channel-
 * connection success, weekly digest, error/failure). Properties that LINE
 * accepts but are rarely used (most theming props beyond the common subset)
 * are not modelled — pass the raw JSON via `Object.assign` if you need them.
 */

// -- Containers ---------------------------------------------------------------

export type FlexContainer = FlexBubble | FlexCarousel

export interface FlexBubble {
  type: 'bubble'
  size?: 'nano' | 'micro' | 'kilo' | 'mega' | 'giga'
  /** Top-to-bottom (default) or bottom-to-top stacking order. */
  direction?: 'ltr' | 'rtl'
  header?: FlexBox
  hero?: FlexImage | FlexVideo | FlexBox
  body?: FlexBox
  footer?: FlexBox
  styles?: FlexBubbleStyles
  action?: FlexAction
}

export interface FlexBubbleStyles {
  header?: FlexBlockStyle
  hero?: FlexBlockStyle
  body?: FlexBlockStyle
  footer?: FlexBlockStyle
}

export interface FlexBlockStyle {
  backgroundColor?: string
  separator?: boolean
  separatorColor?: string
}

export interface FlexCarousel {
  type: 'carousel'
  contents: FlexBubble[]
}

// -- Components ---------------------------------------------------------------

export type FlexComponent =
  | FlexBox
  | FlexText
  | FlexImage
  | FlexIcon
  | FlexButton
  | FlexSeparator
  | FlexSpacer
  | FlexFiller
  | FlexVideo

export type FlexSize =
  | 'none'
  | 'xs'
  | 'sm'
  | 'md'
  | 'lg'
  | 'xl'
  | 'xxl'
  | '3xl'
  | '4xl'
  | '5xl'
  | 'full'
  | string

export interface FlexBox {
  type: 'box'
  layout: 'horizontal' | 'vertical' | 'baseline'
  contents: FlexComponent[]
  flex?: number
  spacing?: FlexSize
  margin?: FlexSize
  paddingAll?: FlexSize
  paddingTop?: FlexSize
  paddingBottom?: FlexSize
  paddingStart?: FlexSize
  paddingEnd?: FlexSize
  width?: string
  height?: string
  maxWidth?: string
  maxHeight?: string
  backgroundColor?: string
  borderColor?: string
  borderWidth?: FlexSize
  cornerRadius?: FlexSize
  justifyContent?:
    | 'flex-start'
    | 'center'
    | 'flex-end'
    | 'space-between'
    | 'space-around'
    | 'space-evenly'
  alignItems?: 'flex-start' | 'center' | 'flex-end'
  position?: 'relative' | 'absolute'
  offsetTop?: string
  offsetBottom?: string
  offsetStart?: string
  offsetEnd?: string
  action?: FlexAction
}

export interface FlexText {
  type: 'text'
  text?: string
  contents?: FlexSpan[]
  flex?: number
  margin?: FlexSize
  position?: 'relative' | 'absolute'
  offsetTop?: string
  offsetBottom?: string
  offsetStart?: string
  offsetEnd?: string
  size?: FlexSize
  align?: 'start' | 'end' | 'center'
  gravity?: 'top' | 'bottom' | 'center'
  wrap?: boolean
  lineSpacing?: string
  maxLines?: number
  weight?: 'regular' | 'bold'
  color?: string
  style?: 'normal' | 'italic'
  decoration?: 'none' | 'underline' | 'line-through'
  adjustMode?: 'shrink-to-fit'
  action?: FlexAction
}

export interface FlexSpan {
  type: 'span'
  text: string
  size?: FlexSize
  color?: string
  weight?: 'regular' | 'bold'
  style?: 'normal' | 'italic'
  decoration?: 'none' | 'underline' | 'line-through'
}

export interface FlexImage {
  type: 'image'
  url: string
  flex?: number
  margin?: FlexSize
  position?: 'relative' | 'absolute'
  offsetTop?: string
  offsetBottom?: string
  offsetStart?: string
  offsetEnd?: string
  align?: 'start' | 'end' | 'center'
  gravity?: 'top' | 'bottom' | 'center'
  size?: FlexSize
  aspectRatio?: string
  aspectMode?: 'cover' | 'fit'
  backgroundColor?: string
  animated?: boolean
  action?: FlexAction
}

export interface FlexIcon {
  type: 'icon'
  url: string
  margin?: FlexSize
  position?: 'relative' | 'absolute'
  offsetTop?: string
  offsetBottom?: string
  offsetStart?: string
  offsetEnd?: string
  size?: FlexSize
  aspectRatio?: string
}

export interface FlexButton {
  type: 'button'
  action: FlexAction
  flex?: number
  margin?: FlexSize
  position?: 'relative' | 'absolute'
  offsetTop?: string
  offsetBottom?: string
  offsetStart?: string
  offsetEnd?: string
  height?: 'sm' | 'md'
  style?: 'link' | 'primary' | 'secondary'
  color?: string
  gravity?: 'top' | 'bottom' | 'center'
  adjustMode?: 'shrink-to-fit'
}

export interface FlexSeparator {
  type: 'separator'
  margin?: FlexSize
  color?: string
}

/** Deprecated by LINE in favor of margin, but still accepted. */
export interface FlexSpacer {
  type: 'spacer'
  size?: FlexSize
}

export interface FlexFiller {
  type: 'filler'
  flex?: number
}

export interface FlexVideo {
  type: 'video'
  url: string
  previewUrl: string
  altContent: FlexImage | FlexBox
  aspectRatio?: string
  action?: FlexAction
}

// -- Actions ------------------------------------------------------------------

/**
 * Mirrors LineAction from src/types.ts but redefined here to keep the Flex
 * tree self-contained (avoids a circular import between flex/* and types.ts).
 */
export type FlexAction =
  | { type: 'message'; label?: string; text: string }
  | {
      type: 'postback'
      label?: string
      data: string
      displayText?: string
      inputOption?: 'closeRichMenu' | 'openRichMenu' | 'openKeyboard' | 'openVoice'
      fillInText?: string
    }
  | {
      type: 'uri'
      label?: string
      uri: string
      altUri?: { desktop?: string }
    }
  | {
      type: 'datetimepicker'
      label?: string
      data: string
      mode: 'date' | 'time' | 'datetime'
      initial?: string
      max?: string
      min?: string
    }
  | { type: 'camera'; label: string }
  | { type: 'cameraRoll'; label: string }
  | { type: 'location'; label: string }
