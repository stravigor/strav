import type {
  FlexAction,
  FlexBox,
  FlexBubble,
  FlexButton,
  FlexCarousel,
  FlexComponent,
  FlexFiller,
  FlexIcon,
  FlexImage,
  FlexSeparator,
  FlexSpan,
  FlexText,
  FlexVideo,
} from './types.ts'
import type { FlexMessage } from '../types.ts'

/**
 * Convenience builders for Flex Messages.
 *
 * These are thin factories: each one takes the required props and an
 * optional bag of overrides, then returns a strongly-typed AST node. The
 * goal is readable composition — `bubble(body(box('vertical', [text('Hi')])))`
 * instead of nested object literals with all the type discriminators.
 *
 * The builders do no validation themselves; pair with `validateFlex()` from
 * `./validate.ts` to enforce LINE's byte-size and structural limits before
 * sending.
 */

// -- Containers ---------------------------------------------------------------

export function bubble(opts: Omit<FlexBubble, 'type'>): FlexBubble {
  return { type: 'bubble', ...opts }
}

export function carousel(contents: FlexBubble[]): FlexCarousel {
  return { type: 'carousel', contents }
}

// -- Components ---------------------------------------------------------------

export function box(
  layout: FlexBox['layout'],
  contents: FlexComponent[],
  opts?: Omit<FlexBox, 'type' | 'layout' | 'contents'>
): FlexBox {
  return { type: 'box', layout, contents, ...opts }
}

export function text(value: string, opts?: Omit<FlexText, 'type' | 'text'>): FlexText {
  return { type: 'text', text: value, ...opts }
}

export function richText(spans: FlexSpan[], opts?: Omit<FlexText, 'type' | 'contents'>): FlexText {
  return { type: 'text', contents: spans, ...opts }
}

export function span(value: string, opts?: Omit<FlexSpan, 'type' | 'text'>): FlexSpan {
  return { type: 'span', text: value, ...opts }
}

export function image(url: string, opts?: Omit<FlexImage, 'type' | 'url'>): FlexImage {
  return { type: 'image', url, ...opts }
}

export function icon(url: string, opts?: Omit<FlexIcon, 'type' | 'url'>): FlexIcon {
  return { type: 'icon', url, ...opts }
}

export function button(action: FlexAction, opts?: Omit<FlexButton, 'type' | 'action'>): FlexButton {
  return { type: 'button', action, ...opts }
}

export function separator(opts?: Omit<FlexSeparator, 'type'>): FlexSeparator {
  return { type: 'separator', ...opts }
}

export function filler(flex?: number): FlexFiller {
  return flex !== undefined ? { type: 'filler', flex } : { type: 'filler' }
}

export function video(
  url: string,
  previewUrl: string,
  altContent: FlexImage | FlexBox,
  opts?: Omit<FlexVideo, 'type' | 'url' | 'previewUrl' | 'altContent'>
): FlexVideo {
  return { type: 'video', url, previewUrl, altContent, ...opts }
}

// -- Actions ------------------------------------------------------------------

export function messageAction(text: string, label?: string): FlexAction {
  return label !== undefined
    ? { type: 'message', label, text }
    : { type: 'message', text }
}

export function postbackAction(
  data: string,
  opts?: { label?: string; displayText?: string }
): FlexAction {
  const out: FlexAction = { type: 'postback', data }
  if (opts?.label !== undefined) (out as { label?: string }).label = opts.label
  if (opts?.displayText !== undefined) (out as { displayText?: string }).displayText = opts.displayText
  return out
}

export function uriAction(uri: string, label?: string): FlexAction {
  return label !== undefined
    ? { type: 'uri', label, uri }
    : { type: 'uri', uri }
}

// -- Top-level message --------------------------------------------------------

/**
 * Compose a complete FlexMessage ready to pass to LineClient.push() / .reply().
 *
 * `altText` is what shows up in chat list previews and push notifications —
 * always supply something descriptive in Thai.
 */
export function flexMessage(
  altText: string,
  contents: FlexBubble | FlexCarousel
): FlexMessage {
  return { type: 'flex', altText, contents }
}
