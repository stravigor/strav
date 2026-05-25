import { LINE_LIMITS } from '../types.ts'
import type { FlexMessage } from '../types.ts'
import type { FlexBubble, FlexCarousel, FlexContainer } from './types.ts'

export class FlexValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FlexValidationError'
  }
}

/**
 * Validate a FlexMessage against LINE's structural and byte-size limits.
 *
 * Throws FlexValidationError on the first violation found. This is meant to
 * be called before send so the failure surfaces in your code, not in a
 * cryptic 400 from the LINE API.
 *
 * Limits enforced (from LINE_LIMITS):
 *   - altText length ≤ 400 chars
 *   - bubble JSON size ≤ 30 KB
 *   - carousel ≥ 1 and ≤ 12 bubbles, every child bubble valid
 */
export function validateFlex(message: FlexMessage): void {
  if (!message.altText) {
    throw new FlexValidationError('FlexMessage requires altText')
  }
  if (message.altText.length > LINE_LIMITS.ALT_TEXT_MAX) {
    throw new FlexValidationError(
      `altText is ${message.altText.length} chars (max ${LINE_LIMITS.ALT_TEXT_MAX})`
    )
  }
  validateContainer(message.contents)
}

export function validateContainer(container: FlexContainer): void {
  if (container.type === 'bubble') {
    validateBubble(container)
  } else {
    validateCarousel(container)
  }
}

export function validateBubble(bubble: FlexBubble): void {
  const bytes = sizeInBytes(bubble)
  if (bytes > LINE_LIMITS.FLEX_BUBBLE_BYTES) {
    throw new FlexValidationError(
      `Bubble serialises to ${bytes} bytes (max ${LINE_LIMITS.FLEX_BUBBLE_BYTES}). ` +
        `Trim text, drop images, or split into a carousel.`
    )
  }
}

export function validateCarousel(carousel: FlexCarousel): void {
  if (carousel.contents.length === 0) {
    throw new FlexValidationError('Carousel must contain at least one bubble')
  }
  if (carousel.contents.length > LINE_LIMITS.FLEX_CAROUSEL_BUBBLES) {
    throw new FlexValidationError(
      `Carousel has ${carousel.contents.length} bubbles (max ${LINE_LIMITS.FLEX_CAROUSEL_BUBBLES})`
    )
  }
  for (const [index, bubble] of carousel.contents.entries()) {
    try {
      validateBubble(bubble)
    } catch (err) {
      throw new FlexValidationError(
        `Bubble #${index} in carousel is invalid: ${(err as Error).message}`
      )
    }
  }
}

function sizeInBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).length
}
