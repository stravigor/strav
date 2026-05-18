import { describe, test, expect } from 'bun:test'
import { ContentStream } from '../src/content/content_stream.ts'
import { gray, rgb, cmyk } from '../src/color/color.ts'
import { PdfGenError } from '../src/util/errors.ts'

const dec = (cs: ContentStream) => new TextDecoder('latin1').decode(cs.toBytes())

describe('content stream builder (§8, M2 acceptance)', () => {
  test('rectangle, line and curve in device color spaces', () => {
    const cs = new ContentStream()
    cs.save()
      .setFillColor(rgb(1, 0, 0))
      .rect(0, 0, 100, 50)
      .fill()
      .setStrokeColor(gray(0))
      .moveTo(0, 0)
      .lineTo(100, 0)
      .stroke()
      .setFillColor(cmyk(0, 0, 0, 1))
      .moveTo(0, 0)
      .curveTo(10, 10, 20, 20, 30, 0)
      .fill()
      .restore()

    expect(dec(cs)).toBe(
      [
        'q',
        '1 0 0 rg',
        '0 0 100 50 re',
        'f',
        '0 G',
        '0 0 m',
        '100 0 l',
        'S',
        '0 0 0 1 k',
        '0 0 m',
        '10 10 20 20 30 0 c',
        'f',
        'Q',
        '',
      ].join('\n')
    )
  })

  test('transform helpers emit cm', () => {
    const cs = new ContentStream()
    cs.translate(20, 30).scale(2, 2)
    expect(dec(cs)).toBe('1 0 0 1 20 30 cm\n2 0 0 2 0 0 cm\n')
  })

  test('unmatched restore throws immediately', () => {
    expect(() => new ContentStream().restore()).toThrow(PdfGenError)
  })

  test('unbalanced q is caught at assertBalanced()', () => {
    const cs = new ContentStream()
    cs.save().rect(0, 0, 1, 1).fill()
    expect(() => cs.assertBalanced()).toThrow(/unmatched save/)
  })

  test('unconsumed path is rejected', () => {
    const cs = new ContentStream()
    cs.rect(0, 0, 10, 10)
    expect(() => cs.assertBalanced()).toThrow(PdfGenError)
  })

  test('starting a save() with an open path throws (§8.4)', () => {
    const cs = new ContentStream()
    cs.moveTo(0, 0).lineTo(1, 1)
    expect(() => cs.save()).toThrow(/Unconsumed path/)
  })

  test('painting with no path throws', () => {
    expect(() => new ContentStream().fill()).toThrow(PdfGenError)
  })

  test('clip then paint consumes the path', () => {
    const cs = new ContentStream()
    cs.rect(0, 0, 10, 10).clip().endPath()
    expect(() => cs.assertBalanced()).not.toThrow()
    expect(dec(cs)).toBe('0 0 10 10 re\nW\nn\n')
  })

  test('color components out of range throw', () => {
    expect(() => rgb(2, 0, 0)).toThrow(PdfGenError)
    expect(() => gray(-1)).toThrow(PdfGenError)
  })
})
