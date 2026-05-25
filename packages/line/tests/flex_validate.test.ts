import { describe, expect, test } from 'bun:test'
import {
  FlexValidationError,
  bubble,
  carousel,
  flexMessage,
  text,
  validateFlex,
} from '../src/flex/index.ts'
import { LINE_LIMITS } from '../src/types.ts'

describe('validateFlex', () => {
  test('accepts a small bubble', () => {
    const m = flexMessage('ok', bubble({ body: { type: 'box', layout: 'vertical', contents: [text('hi')] } }))
    expect(() => validateFlex(m)).not.toThrow()
  })

  test('rejects empty altText', () => {
    const m = flexMessage('', bubble({}))
    expect(() => validateFlex(m)).toThrow(FlexValidationError)
  })

  test('rejects oversized altText', () => {
    const m = flexMessage('x'.repeat(LINE_LIMITS.ALT_TEXT_MAX + 1), bubble({}))
    expect(() => validateFlex(m)).toThrow(FlexValidationError)
  })

  test('rejects an empty carousel', () => {
    const m = flexMessage('ok', carousel([]))
    expect(() => validateFlex(m)).toThrow('at least one bubble')
  })

  test('rejects a carousel over the bubble cap', () => {
    const bubbles = Array.from({ length: LINE_LIMITS.FLEX_CAROUSEL_BUBBLES + 1 }, () => bubble({}))
    const m = flexMessage('ok', carousel(bubbles))
    expect(() => validateFlex(m)).toThrow('max')
  })

  test('rejects a bubble that exceeds the byte ceiling', () => {
    // Build a bubble whose body contains a single text node large enough to
    // push the serialised JSON over the 30KB limit on its own.
    const huge = text('x'.repeat(LINE_LIMITS.FLEX_BUBBLE_BYTES + 1))
    const m = flexMessage(
      'ok',
      bubble({ body: { type: 'box', layout: 'vertical', contents: [huge] } })
    )
    expect(() => validateFlex(m)).toThrow('bytes')
  })
})
