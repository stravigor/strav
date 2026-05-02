import { describe, expect, test } from 'bun:test'
import { writeCsv, writeCsvRow } from '../src/csv/writer.ts'
import { readCsv } from '../src/csv/reader.ts'

class StringSink {
  buffer = ''
  write(s: string) { this.buffer += s }
}

describe('writeCsvRow', () => {
  test('serializes plain values', () => {
    expect(writeCsvRow(['a', 'b', 1, true])).toBe('a,b,1,true')
  })

  test('quotes fields containing the delimiter', () => {
    expect(writeCsvRow(['a,b', 'c'])).toBe('"a,b",c')
  })

  test('doubles embedded quote characters', () => {
    expect(writeCsvRow(['She said "hi"', 'x'])).toBe('"She said ""hi""",x')
  })

  test('quotes fields containing newlines', () => {
    expect(writeCsvRow(['line1\nline2'])).toBe('"line1\nline2"')
  })

  test('null and undefined serialize to empty string', () => {
    expect(writeCsvRow([null, undefined, 'x'])).toBe(',,x')
  })
})

describe('writeCsv', () => {
  test('round-trips through readCsv', async () => {
    const sink = new StringSink()
    await writeCsv(
      [
        { Email: 'a@x.com', Name: 'A, with comma' },
        { Email: 'b@x.com', Name: 'B "quoted"' },
        { Email: 'c@x.com', Name: 'multi\nline' },
      ],
      sink
    )
    const back = []
    for await (const row of readCsv(sink.buffer)) back.push(row)
    expect(back).toEqual([
      { Email: 'a@x.com', Name: 'A, with comma' },
      { Email: 'b@x.com', Name: 'B "quoted"' },
      { Email: 'c@x.com', Name: 'multi\nline' },
    ])
  })

  test('uses explicit columns to control order', async () => {
    const sink = new StringSink()
    await writeCsv(
      [{ a: 1, b: 2, c: 3 }],
      sink,
      { columns: ['c', 'a', 'b'] }
    )
    expect(sink.buffer).toBe('c,a,b\n3,1,2\n')
  })

  test('writeHeader: false omits the header row', async () => {
    const sink = new StringSink()
    await writeCsv([{ a: 1, b: 2 }], sink, { writeHeader: false })
    expect(sink.buffer).toBe('1,2\n')
  })

  test('returns the row count', async () => {
    const sink = new StringSink()
    const count = await writeCsv([{ a: 1 }, { a: 2 }, { a: 3 }], sink)
    expect(count).toBe(3)
  })
})
