import { describe, expect, test } from 'bun:test'
import { readJsonl } from '../src/jsonl/reader.ts'
import { writeJsonl } from '../src/jsonl/writer.ts'

class StringSink {
  buffer = ''
  write(s: string) { this.buffer += s }
}

async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = []
  for await (const x of iter) result.push(x)
  return result
}

describe('readJsonl', () => {
  test('parses each line as a JSON value', async () => {
    const rows = await collect(readJsonl('{"a":1}\n{"a":2}\n{"a":3}\n'))
    expect(rows).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }])
  })

  test('skips blank lines', async () => {
    const rows = await collect(readJsonl('{"a":1}\n\n{"a":2}\n'))
    expect(rows).toEqual([{ a: 1 }, { a: 2 }])
  })

  test('handles CRLF line separators', async () => {
    const rows = await collect(readJsonl('{"a":1}\r\n{"a":2}\r\n'))
    expect(rows).toEqual([{ a: 1 }, { a: 2 }])
  })

  test('handles trailing line without newline', async () => {
    const rows = await collect(readJsonl('{"a":1}\n{"a":2}'))
    expect(rows).toEqual([{ a: 1 }, { a: 2 }])
  })

  test('handles input split across chunks mid-line', async () => {
    async function* chunks() {
      yield '{"a":'
      yield '1}\n{"a"'
      yield ':2}\n'
    }
    const rows = await collect(readJsonl(chunks()))
    expect(rows).toEqual([{ a: 1 }, { a: 2 }])
  })

  test('throws on invalid JSON line', async () => {
    await expect(collect(readJsonl('{"a":1}\nnot-json\n'))).rejects.toThrow()
  })
})

describe('writeJsonl', () => {
  test('round-trips through readJsonl', async () => {
    const sink = new StringSink()
    await writeJsonl([{ a: 1 }, { a: 2 }, { tag: 'x' }], sink)
    const back = await collect(readJsonl(sink.buffer))
    expect(back).toEqual([{ a: 1 }, { a: 2 }, { tag: 'x' }])
  })

  test('returns row count', async () => {
    const sink = new StringSink()
    const count = await writeJsonl([{ a: 1 }, { a: 2 }], sink)
    expect(count).toBe(2)
  })
})
