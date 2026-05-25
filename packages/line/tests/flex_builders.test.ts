import { describe, expect, test } from 'bun:test'
import {
  box,
  bubble,
  button,
  carousel,
  filler,
  flexMessage,
  icon,
  image,
  messageAction,
  postbackAction,
  separator,
  span,
  text,
  uriAction,
  richText,
} from '../src/flex/builders.ts'

describe('flex builders', () => {
  test('bubble factory injects the discriminator', () => {
    const b = bubble({ body: box('vertical', [text('hi')]) })
    expect(b.type).toBe('bubble')
    expect(b.body).toBeDefined()
  })

  test('carousel wraps bubbles', () => {
    const c = carousel([bubble({}), bubble({})])
    expect(c.type).toBe('carousel')
    expect(c.contents).toHaveLength(2)
  })

  test('text builder preserves overrides', () => {
    const t = text('hello', { weight: 'bold', color: '#000' })
    expect(t).toEqual({ type: 'text', text: 'hello', weight: 'bold', color: '#000' })
  })

  test('richText uses spans instead of text', () => {
    const t = richText([span('a'), span('b', { weight: 'bold' })])
    expect(t.type).toBe('text')
    expect(t.contents).toHaveLength(2)
    expect(t.contents?.[1]?.weight).toBe('bold')
  })

  test('box honours layout + nested contents', () => {
    const b = box('horizontal', [image('https://x/y.png'), filler(2)])
    expect(b.layout).toBe('horizontal')
    expect(b.contents).toHaveLength(2)
    expect(b.contents[0]?.type).toBe('image')
    expect(b.contents[1]?.type).toBe('filler')
  })

  test('button wraps an action', () => {
    const b = button(messageAction('hello'), { style: 'primary' })
    expect(b.action.type).toBe('message')
    expect(b.style).toBe('primary')
  })

  test('separator and icon factories produce correct shape', () => {
    expect(separator({ margin: 'md' }).type).toBe('separator')
    expect(icon('https://x/y.png').type).toBe('icon')
  })

  test('action factories construct each variant', () => {
    expect(messageAction('hi', 'Hi label')).toEqual({
      type: 'message',
      label: 'Hi label',
      text: 'hi',
    })
    expect(postbackAction('a=1', { label: 'L', displayText: 'D' })).toEqual({
      type: 'postback',
      data: 'a=1',
      label: 'L',
      displayText: 'D',
    })
    expect(uriAction('https://x', 'Open')).toEqual({
      type: 'uri',
      label: 'Open',
      uri: 'https://x',
    })
  })

  test('flexMessage composes altText + container', () => {
    const m = flexMessage('Preview', bubble({ body: box('vertical', [text('hi')]) }))
    expect(m.type).toBe('flex')
    expect(m.altText).toBe('Preview')
    expect(m.contents.type).toBe('bubble')
  })
})
